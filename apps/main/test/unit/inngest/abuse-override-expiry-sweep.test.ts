// #1830 — abuse-override-expiry-sweep crash-safety.
// #1844 — DB-backed audit dedup (D-091 #24).
//
// Intent pinned here: the two per-row writes (usage_limit_events audit insert,
// tenant_usage_overrides.expiry_notified_at stamp) are dependent — the stamp
// means "expiry fully processed, audit included" — but were originally
// ordered stamp-then-audit. A crash between them permanently dropped the
// audit row: the stamped row is never re-selected by a later sweep (the
// query filters on expiry_notified_at IS NULL), so the lost insert can never
// be retried. Reordering to audit-first closes that window: a crash before
// the stamp leaves the row re-selectable, and re-running produces exactly
// ONE usage_limit_events row, not a duplicate.
//
// Since #1844 the dedup is enforced by the DB, not an app-level SELECT-first
// check: a partial unique index on resolution_action (scoped to the
// 'override_expired:%' namespace — other writers reuse constant values like
// 'subscription_change_recompute') rejects a duplicate insert with 23505,
// which the sweep treats as "already recorded". The fake DB below mirrors
// that index so these tests fail if the 23505 handler regresses.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    send: vi.fn().mockResolvedValue(undefined),
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

interface OverrideRow {
  id: string;
  tenant_id: string;
  dimension: string;
  effective_to: string;
  expiry_notified_at: string | null;
}
interface EventRow {
  id: string;
  tenant_id: string;
  dimension: string;
  resolution_action: string;
}

interface State {
  overrides: OverrideRow[];
  events: EventRow[];
  auditLog: unknown[];
}

// Minimal fluent query mock over the in-memory state. Supports exactly the
// chains the sweep + withPlatformAdminAudit's audit-log write use.
function makeDb(state: State, opts: { failStampFor?: Set<string> } = {}) {
  let eventSeq = 0;
  return {
    from(table: string) {
      const filters: Array<[string, "eq" | "lt" | "is", unknown]> = [];
      let op: "select" | "update" | "insert" = "select";
      let payload: Record<string, unknown> | null = null;
      let limitN: number | null = null;

      const rowsFor = (): Record<string, unknown>[] =>
        (table === "tenant_usage_overrides"
          ? state.overrides
          : table === "usage_limit_events"
            ? state.events
            : table === "audit_log"
              ? state.auditLog
              : []) as unknown as Record<string, unknown>[];

      const matches = (r: Record<string, unknown>) =>
        filters.every(([c, fop, v]) => {
          if (fop === "eq") return r[c] === v;
          if (fop === "lt") return (r[c] as string) < (v as string);
          return r[c] == null; // "is" — only ever used with null in this module
        });

      const run = () => {
        const target = rowsFor();
        if (op === "select") {
          let matched = target.filter(matches);
          if (limitN != null) matched = matched.slice(0, limitN);
          return { data: matched, error: null };
        }
        if (op === "update") {
          const idFilter = filters.find(([c]) => c === "id");
          const rowId = idFilter?.[2] as string | undefined;
          if (table === "tenant_usage_overrides" && rowId && opts.failStampFor?.has(rowId)) {
            opts.failStampFor.delete(rowId); // fails exactly once per row
            return { data: null, error: { message: "simulated crash", code: "XX000" } };
          }
          const matched = target.filter(matches);
          for (const r of matched) Object.assign(r, payload);
          return { data: null, error: null };
        }
        // insert — mirror usage_limit_events_override_expired_uidx (partial
        // unique on resolution_action WHERE 'override_expired:%'): duplicate
        // keys in that namespace violate with 23505 instead of landing.
        const ra = (payload as Record<string, unknown>).resolution_action;
        if (
          table === "usage_limit_events" &&
          typeof ra === "string" &&
          ra.startsWith("override_expired:") &&
          state.events.some((e) => e.resolution_action === ra)
        ) {
          return {
            data: null,
            error: {
              code: "23505",
              message: 'duplicate key value violates unique constraint "usage_limit_events_override_expired_uidx"',
            },
          };
        }
        target.push({ id: `evt-${++eventSeq}`, ...(payload as Record<string, unknown>) });
        return { data: null, error: null };
      };

      const chain: Record<string, unknown> = {
        select(_c?: string) {
          return chain;
        },
        update(p: Record<string, unknown>) {
          op = "update";
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
        lt(c: string, v: unknown) {
          filters.push([c, "lt", v]);
          return chain;
        },
        is(c: string, v: unknown) {
          filters.push([c, "is", v]);
          return chain;
        },
        limit(n: number) {
          limitN = n;
          return chain;
        },
        maybeSingle() {
          const r = run();
          return Promise.resolve({ data: (r.data as unknown[])[0] ?? null, error: r.error });
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

function makeState(): State {
  return {
    overrides: [
      {
        id: "ov-1",
        tenant_id: "t-1",
        dimension: "ai_calls",
        effective_to: "2020-01-01",
        expiry_notified_at: null,
      },
    ],
    events: [],
    auditLog: [],
  };
}

async function runSweep(): Promise<unknown> {
  vi.resetModules();
  const { abuseOverrideExpirySweep } = await import("@/inngest/abuse-override-expiry-sweep");
  const fn = abuseOverrideExpirySweep as unknown as { handler: () => Promise<unknown> };
  return fn.handler();
}

beforeEach(() => {
  delete process.env.STAGING_MODE;
  // The vi.mock factory is memoized across vi.resetModules, so the shared
  // `send` spy would otherwise accumulate calls across tests.
  vi.clearAllMocks();
});

describe("#1830 — abuse-override-expiry-sweep write ordering", () => {
  it("audit-inserts before stamping (happy path produces exactly one event + one stamp + one recompute send)", async () => {
    const state = makeState();
    currentDb = makeDb(state);
    const result = await runSweep();
    expect(result).toEqual({ expired_overrides: 1, tenants_recomputed: 1 });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.resolution_action).toBe("override_expired:ov-1");
    expect(state.overrides[0]!.expiry_notified_at).not.toBeNull();
    // The recompute event carries the touched tenant, not just a count.
    const { inngest } = await import("@/inngest/client");
    expect(inngest.send).toHaveBeenCalledExactlyOnceWith({
      name: "tenant.subscription_changed",
      data: { tenant_id: "t-1", change: "tier" },
    });
  });

  it("a crash between the audit insert and the stamp leaves the row re-selectable, and re-running does not duplicate the audit row", async () => {
    const state = makeState();
    // First run: the audit insert succeeds, then the stamp update crashes.
    currentDb = makeDb(state, { failStampFor: new Set(["ov-1"]) });

    await expect(runSweep()).rejects.toThrow();

    // The audit row landed before the crash...
    expect(state.events).toHaveLength(1);
    // ...but the stamp never happened, so the row stays re-selectable.
    expect(state.overrides[0]!.expiry_notified_at).toBeNull();

    // Second run (next day's cron, or a manual retry): the stamp update no
    // longer fails. Re-selects the same row (still un-stamped).
    currentDb = makeDb(state);
    const result = await runSweep();

    expect(result).toEqual({ expired_overrides: 1, tenants_recomputed: 1 });
    // Exactly one usage_limit_events row per expired override — the unique
    // index rejected the duplicate insert with 23505 and the sweep treated
    // it as "already recorded" instead of throwing.
    expect(state.events).toHaveLength(1);
    expect(state.overrides[0]!.expiry_notified_at).not.toBeNull();
  });

  it("a lost race (event row already recorded by a concurrent invocation) is a handled no-op, not an error", async () => {
    // #1844 / D-091 #24 — the pre-existing row simulates a concurrent sweep
    // invocation winning the insert. No SELECT-first check protects this
    // path anymore; only the DB unique index + 23505 handler do.
    const state = makeState();
    state.events.push({
      id: "evt-preexisting",
      tenant_id: "t-1",
      dimension: "ai_calls",
      resolution_action: "override_expired:ov-1",
    });
    currentDb = makeDb(state);

    const result = await runSweep();

    expect(result).toEqual({ expired_overrides: 1, tenants_recomputed: 1 });
    expect(state.events).toHaveLength(1);
    // The row still gets stamped — the 23505 means "audit already recorded",
    // so processing continues to completion.
    expect(state.overrides[0]!.expiry_notified_at).not.toBeNull();
  });

  it("two expired overrides for the same tenant produce two audit rows but one recompute", async () => {
    const state = makeState();
    state.overrides.push({
      id: "ov-2",
      tenant_id: "t-1",
      dimension: "messages",
      effective_to: "2020-02-01",
      expiry_notified_at: null,
    });
    currentDb = makeDb(state);

    const result = await runSweep();

    expect(result).toEqual({ expired_overrides: 2, tenants_recomputed: 1 });
    expect(state.events.map((e) => e.resolution_action).sort()).toEqual([
      "override_expired:ov-1",
      "override_expired:ov-2",
    ]);
    const { inngest } = await import("@/inngest/client");
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it("skips entirely in STAGING_MODE without touching the DB", async () => {
    process.env.STAGING_MODE = "true";
    const state = makeState();
    currentDb = makeDb(state);
    const result = await runSweep();
    expect(result).toEqual({ skipped_for_staging: true });
    expect(state.events).toHaveLength(0);
    expect(state.overrides[0]!.expiry_notified_at).toBeNull();
  });
});
