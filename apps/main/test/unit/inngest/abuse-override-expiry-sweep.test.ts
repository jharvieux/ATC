// #1830 — abuse-override-expiry-sweep crash-safety.
//
// Intent pinned here: the two per-row writes (usage_limit_events audit insert,
// tenant_usage_overrides.expiry_notified_at stamp) are dependent — the stamp
// means "expiry fully processed, audit included" — but were originally
// ordered stamp-then-audit. A crash between them permanently dropped the
// audit row: the stamped row is never re-selected by a later sweep (the
// query filters on expiry_notified_at IS NULL), so the lost insert can never
// be retried. Reordering to audit-first + an idempotent existence check
// closes that window: a crash before the stamp leaves the row re-selectable,
// and re-running produces exactly ONE usage_limit_events row, not a
// duplicate.

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
        // insert
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
});

describe("#1830 — abuse-override-expiry-sweep write ordering", () => {
  it("audit-inserts before stamping (happy path produces exactly one event + one stamp)", async () => {
    const state = makeState();
    currentDb = makeDb(state);
    const result = await runSweep();
    expect(result).toEqual({ expired_overrides: 1, tenants_recomputed: 1 });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.resolution_action).toBe("override_expired:ov-1");
    expect(state.overrides[0]!.expiry_notified_at).not.toBeNull();
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
    // Exactly one usage_limit_events row per expired override — the
    // existence check skipped the duplicate insert.
    expect(state.events).toHaveLength(1);
    expect(state.overrides[0]!.expiry_notified_at).not.toBeNull();
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
