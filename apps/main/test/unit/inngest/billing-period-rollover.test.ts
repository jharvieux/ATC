// #1885 — billing-period-rollover had zero unit coverage after #1827's
// sequential-loop → mapWithConcurrency refactor. Pins: per-tenant outcome
// tallies (created vs skipped-non-paying), that a single tenant's audit-
// insert failure aborts the whole rollover (mapWithConcurrency has no
// per-item catch), and that a >concurrency fan-out neither drops nor
// double-processes a tenant.
//
// Also surfaces (does NOT fix — tests-only per #1885 scope) a real
// idempotency gap: the tenant_usage_metrics upsert is correctly
// ON CONFLICT DO NOTHING (dedups across reruns), but the 4
// usage_limit_events audit inserts per tenant have no such guard, so a
// retry of the same period re-inserts a fresh set of audit rows. Tracked
// as #1901.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

interface TenantRow {
  id: string;
  status: string;
  subscription_status: string | null;
  non_paying_since: string | null;
  is_platform_internal?: boolean;
}
interface MetricsRow {
  tenant_id: string;
  billing_period: string;
  [k: string]: unknown;
}
interface EventRow {
  tenant_id: string;
  dimension: string;
  [k: string]: unknown;
}

interface State {
  tenants: TenantRow[];
  metrics: MetricsRow[];
  events: EventRow[];
  auditLog: unknown[];
}

// Fluent mock supporting exactly the chains billing-period-rollover.ts (via
// withPlatformAdminAudit) uses: tenants select().in().limit(), an upsert
// with onConflict/ignoreDuplicates on tenant_usage_metrics, plain inserts on
// usage_limit_events, and the audit_log insert from writeAuditRow.
function makeDb(state: State, opts: { failEventInsertFor?: Set<string> } = {}) {
  let seq = 0;
  return {
    from(table: string) {
      const filters: Array<[string, "eq" | "in", unknown]> = [];
      let op: "select" | "upsert" | "insert" = "select";
      let payload: Record<string, unknown> | null = null;
      let limitN: number | null = null;

      const rowsFor = (): Record<string, unknown>[] =>
        (table === "tenants"
          ? state.tenants
          : table === "tenant_usage_metrics"
            ? state.metrics
            : table === "usage_limit_events"
              ? state.events
              : table === "audit_log"
                ? state.auditLog
                : []) as unknown as Record<string, unknown>[];

      const matches = (r: Record<string, unknown>) =>
        filters.every(([c, fop, v]) =>
          fop === "in" ? (v as unknown[]).includes(r[c]) : r[c] === v,
        );

      const run = () => {
        if (op === "select") {
          let matched = rowsFor().filter(matches);
          if (limitN != null) matched = matched.slice(0, limitN);
          return { data: matched, error: null };
        }
        if (op === "upsert") {
          const p = payload as MetricsRow;
          const exists = state.metrics.some(
            (r) => r.tenant_id === p.tenant_id && r.billing_period === p.billing_period,
          );
          // ON CONFLICT (tenant_id, billing_period) DO NOTHING: no error either
          // way, and no overwrite of an existing row (real upsert semantics).
          if (!exists) state.metrics.push({ ...p });
          return { data: null, error: null };
        }
        // insert (usage_limit_events)
        const p = payload as EventRow;
        if (table === "usage_limit_events" && opts.failEventInsertFor?.has(p.tenant_id)) {
          return { data: null, error: { message: "simulated write failure", code: "XX000" } };
        }
        rowsFor().push({ id: `row-${++seq}`, ...p } as unknown as Record<string, unknown>);
        return { data: null, error: null };
      };

      const chain: Record<string, unknown> = {
        select(_c?: string) {
          return chain;
        },
        upsert(p: Record<string, unknown>, _o?: unknown) {
          op = "upsert";
          payload = p;
          return chain;
        },
        insert(p: Record<string, unknown>) {
          op = "insert";
          payload = p;
          return chain;
        },
        eq(c: string, v: unknown) {
          filters.push([c, "eq", v]);
          return chain;
        },
        in(c: string, v: unknown) {
          filters.push([c, "in", v as unknown[]]);
          return chain;
        },
        limit(n: number) {
          limitN = n;
          return chain;
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(resolve(run()));
        },
      };
      return chain;
    },
  };
}

let currentDb: ReturnType<typeof makeDb>;
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => currentDb,
}));

function makeTenant(id: string, overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id,
    status: "active",
    subscription_status: "active",
    non_paying_since: null,
    is_platform_internal: false,
    ...overrides,
  };
}

function makeState(tenants: TenantRow[]): State {
  return { tenants, metrics: [], events: [], auditLog: [] };
}

async function runRollover(): Promise<unknown> {
  vi.resetModules();
  const { billingPeriodRollover } = await import("@/inngest/billing-period-rollover");
  const fn = billingPeriodRollover as unknown as { handler: () => Promise<unknown> };
  return fn.handler();
}

beforeEach(() => {
  delete process.env.STAGING_MODE;
  vi.clearAllMocks();
});

describe("#1885 — billing-period-rollover outcome tallies", () => {
  it("seeds a fresh tenant_usage_metrics row + 4 audit events per active tenant", async () => {
    const state = makeState([makeTenant("t-1"), makeTenant("t-2")]);
    currentDb = makeDb(state);

    const result = await runRollover();

    expect(result).toMatchObject({ tenants_seeded: 2, tenants_skipped_non_paying: 0, rollover_events: 8 });
    expect(state.metrics).toHaveLength(2);
    expect(state.events).toHaveLength(8);
    expect(state.events.filter((e) => e.tenant_id === "t-1")).toHaveLength(4);
    expect(state.events.filter((e) => e.tenant_id === "t-2")).toHaveLength(4);
    expect(new Set(state.events.filter((e) => e.tenant_id === "t-1").map((e) => e.dimension))).toEqual(
      new Set(["ai_cost", "chat_volume", "email_volume", "group_invite"]),
    );
  });

  it("excludes a past-grace non-paying tenant from the tally but keeps an internal tenant (#699)", async () => {
    const state = makeState([
      makeTenant("t-paying"),
      makeTenant("t-past-grace", {
        subscription_status: "canceled",
        non_paying_since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeTenant("t-internal", { subscription_status: null, is_platform_internal: true }),
    ]);
    currentDb = makeDb(state);

    const result = await runRollover();

    expect(result).toMatchObject({ tenants_seeded: 2, tenants_skipped_non_paying: 1, rollover_events: 8 });
    expect(state.metrics.map((m) => m.tenant_id).sort()).toEqual(["t-internal", "t-paying"]);
  });

  it("skips entirely in STAGING_MODE without touching the DB", async () => {
    process.env.STAGING_MODE = "true";
    const state = makeState([makeTenant("t-1")]);
    currentDb = makeDb(state);

    const result = await runRollover();

    expect(result).toEqual({ skipped_for_staging: true });
    expect(state.metrics).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});

describe("#1885 — billing-period-rollover error isolation", () => {
  it("pins ACTUAL behavior: one tenant's audit-event insert failure rejects the whole rollover", async () => {
    // mapWithConcurrency has no per-item try/catch — safeAwait throwing for
    // one tenant's usage_limit_events insert rejects the shared Promise.all,
    // so the function throws instead of returning a partial tally. No
    // per-tenant isolation today.
    const state = makeState([makeTenant("t-ok"), makeTenant("t-bad")]);
    currentDb = makeDb(state, { failEventInsertFor: new Set(["t-bad"]) });

    await expect(runRollover()).rejects.toThrow();
  });
});

describe("#1885 — billing-period-rollover idempotent re-run", () => {
  it("does not duplicate tenant_usage_metrics rows on a re-run of the same period", async () => {
    const state = makeState([makeTenant("t-1"), makeTenant("t-2")]);
    currentDb = makeDb(state);
    await runRollover();
    expect(state.metrics).toHaveLength(2);

    currentDb = makeDb(state);
    const second = await runRollover();

    // ON CONFLICT DO NOTHING means the metrics table stays at exactly one
    // row per tenant across reruns.
    expect(state.metrics).toHaveLength(2);
    expect(second).toMatchObject({ tenants_seeded: 2 });
  });

  it("KNOWN GAP (tests-only, not fixed here): usage_limit_events is NOT deduped across reruns — a retry doubles the audit rows", async () => {
    // This pins the current (buggy) behavior so a future fix has a failing
    // test to flip green, per #1885's "idempotent re-run" acceptance
    // criterion surfacing exactly this kind of gap. Tracked as #1901
    // rather than fixed in this tests-only PR.
    const state = makeState([makeTenant("t-1")]);
    currentDb = makeDb(state);
    await runRollover();
    expect(state.events).toHaveLength(4);

    currentDb = makeDb(state);
    await runRollover();

    expect(state.events).toHaveLength(8);
  });
});

describe("#1885 — billing-period-rollover concurrency fan-out correctness", () => {
  it("processes every tenant exactly once when tenant count exceeds ROLLOVER_CONCURRENCY (20)", async () => {
    const tenants = Array.from({ length: 45 }, (_, i) => makeTenant(`t-${i}`));
    const state = makeState(tenants);
    currentDb = makeDb(state);

    const result = await runRollover();

    expect(result).toMatchObject({ tenants_seeded: 45, tenants_skipped_non_paying: 0, rollover_events: 180 });
    expect(state.metrics).toHaveLength(45);
    expect(new Set(state.metrics.map((m) => m.tenant_id)).size).toBe(45);
    for (const t of tenants) {
      expect(state.events.filter((e) => e.tenant_id === t.id)).toHaveLength(4);
    }
  });
});
