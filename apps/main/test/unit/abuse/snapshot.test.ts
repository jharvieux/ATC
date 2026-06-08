// #393 / D-091 — loadTenantSnapshot must fail CLOSED on a read error.
//
// The regression this guards: the three reads here used to discard `error`.
// On a DB blip the `tenants` read returned null, which the function could not
// distinguish from "tenant not found" — so it fell through to the healthy stub
// (tier byo_research, ai_cost_state "ok"). That stub then UNDER-enforces the
// §27 AI-cost gates downstream. A read failure must throw; only a genuine
// not-found may return the stub.

import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadTenantSnapshot, _resetSnapshotCacheForTests } from "@/lib/abuse/snapshot";

type Result = { data: unknown; error: { message: string } | null };
type Chain = {
  select: () => Chain;
  eq: () => Chain;
  order: () => Chain;
  limit: () => Chain;
  maybeSingle: () => Promise<Result>;
};

function snapshotDb(byTable: Record<string, Result>): SupabaseClient {
  const makeChain = (table: string): Chain => {
    const chain: Chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(byTable[table] ?? { data: null, error: null }),
    };
    return chain;
  };
  return { from: (table: string) => makeChain(table) } as unknown as SupabaseClient;
}

beforeEach(() => {
  _resetSnapshotCacheForTests();
});

describe("loadTenantSnapshot — fail-closed on read error (#393)", () => {
  it("THROWS when the tenants read errors rather than returning the healthy stub", async () => {
    const db = snapshotDb({ tenants: { data: null, error: { message: "connection reset" } } });
    await expect(loadTenantSnapshot(db, "tn-1")).rejects.toThrow(/tenants\.load-snapshot/);
  });

  it("THROWS when the metrics read errors (cost-state must not silently default to ok)", async () => {
    const db = snapshotDb({
      tenants: { data: { id: "tn-1", tier_id: "tier-1", seat_count: 1, billing_period: "monthly" }, error: null },
      tier_definitions: { data: { code: "sub_pro" }, error: null },
      tenant_usage_metrics: { data: null, error: { message: "pool timeout" } },
    });
    await expect(loadTenantSnapshot(db, "tn-1")).rejects.toThrow(/tenant_usage_metrics\.load-ai-cost-state/);
  });

  it("returns the stub when the tenant genuinely does not exist (null, no error)", async () => {
    const db = snapshotDb({ tenants: { data: null, error: null } });
    const snap = await loadTenantSnapshot(db, "tn-1");
    expect(snap.tenant.tier_code).toBe("byo_research");
    expect(snap.ai_cost_state).toBe("ok");
  });

  it("returns the real tier + cost-state on the happy path (intact)", async () => {
    const db = snapshotDb({
      tenants: { data: { id: "tn-1", tier_id: "tier-1", seat_count: 3, billing_period: "annual" }, error: null },
      tier_definitions: { data: { code: "sub_pro" }, error: null },
      tenant_usage_metrics: { data: { ai_cost_limit_state: "soft2" }, error: null },
    });
    const snap = await loadTenantSnapshot(db, "tn-1");
    expect(snap.tenant.tier_code).toBe("sub_pro");
    expect(snap.tenant.seat_count).toBe(3);
    expect(snap.tenant.billing_period).toBe("annual");
    expect(snap.ai_cost_state).toBe("soft2");
  });

  it("is_platform_internal=true → ai_cost_state is always 'ok', tier_code resolved from real tier", async () => {
    // WHY: platform-internal tenants (Booking) must never see "temporarily
    // unavailable" due to AI spend limits. The exemption must use the real
    // tier_code so model selection and caps are correct.
    const db = snapshotDb({
      tenants: { data: { id: "tn-1", tier_id: "tier-1", seat_count: 2, billing_period: "monthly", is_platform_internal: true }, error: null },
      tier_definitions: { data: { code: "sub_pro" }, error: null },
      // tenant_usage_metrics intentionally absent — the early return must
      // fire before this table is queried; if it is queried, safeAwait throws.
    });
    const snap = await loadTenantSnapshot(db, "tn-1");
    expect(snap.ai_cost_state).toBe("ok");
    expect(snap.tenant.tier_code).toBe("sub_pro"); // real tier, not byo_research stub
    expect(snap.tenant.seat_count).toBe(2);
  });

  it("is_platform_internal=false → normal cost-state path runs (regression guard)", async () => {
    const db = snapshotDb({
      tenants: { data: { id: "tn-1", tier_id: "tier-1", seat_count: 1, billing_period: "monthly", is_platform_internal: false }, error: null },
      tier_definitions: { data: { code: "sub_pro" }, error: null },
      tenant_usage_metrics: { data: { ai_cost_limit_state: "hard" }, error: null },
    });
    const snap = await loadTenantSnapshot(db, "tn-1");
    expect(snap.ai_cost_state).toBe("hard"); // gate still active for non-internal tenants
  });
});
