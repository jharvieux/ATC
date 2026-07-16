// #1789 — pins the batched tier_definitions lookup in abuse-recompute-nightly.
//
// WHY this file exists: the #1789 perf sweep rewrote N per-tenant
// `tier_definitions ... maybeSingle()` lookups into ONE `.in()` query plus an
// in-memory Map. That is a semantic rewrite, not a reordering, and it sits on
// the blast path for abuse enforcement:
//
//   tier_code -> tenantSnapshot -> checkStateTransitionIfNeeded
//               -> resolveThresholdsSync
//
// "byo_research" is the LOWEST tier (chat 500 vs sub_agency 15000), and it is
// also the default when a tier_id doesn't resolve. So the two ways this batch
// can break both end in false-positive abuse enforcement against paying
// customers:
//
//   1. Map cross-assignment — tenant A silently gets tenant B's tier_code.
//   2. A failed tier_definitions read yielding an empty Map — EVERY tenant in
//      the run drops to byo_research at once. Serially this mis-tiered one
//      tenant; batched it mis-tiers the whole run from a single blip.
//
// These tests assert on the tier_code that actually reaches the state machine
// (the real consumer), not on the Map internals.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StateCall {
  tenant_id: string;
  tier_code: string;
}

const mocks = vi.hoisted(() => ({
  tenantRows: [] as Array<{ id: string; tier_id: string | null }>,
  tierRows: [] as Array<{ id: string; code: string }>,
  tierError: null as { message: string; code: string; hint: null; details: null; name: string } | null,
  stateCalls: [] as StateCall[],
}));

// Minimal thenable query stub: every chained filter returns `this`, and the
// terminal await resolves to the shape the cron expects for that table.
function makeQuery(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "lt", "is", "not", "limit", "update", "insert"]) {
    q[m] = () => q;
  }
  q.maybeSingle = () => Promise.resolve(result);
  q.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return q;
}

function makeDb() {
  return {
    from: (table: string) => {
      if (table === "tenants") return makeQuery({ data: mocks.tenantRows, error: null });
      if (table === "tier_definitions") {
        return makeQuery({
          data: mocks.tierError ? null : mocks.tierRows,
          error: mocks.tierError,
        });
      }
      // Every other table: no drift, no rows. Keeps the loop running so the
      // state-machine spy gets to observe each tenant's tier_code.
      return makeQuery({ data: [], error: null });
    },
  };
}

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => fn(makeDb(), () => {}),
  platformAdminClient: () => makeDb(),
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async (args: {
    tenant: { tenant_id: string; tier_code: string };
    dimension: string;
  }) => {
    // The cron calls this once per dimension; one record per tenant is enough
    // to pin the tier_code that reached the state machine.
    if (args.dimension === "ai_cost") {
      mocks.stateCalls.push({ tenant_id: args.tenant.tenant_id, tier_code: args.tenant.tier_code });
    }
  },
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  excludeNonPayingPastGrace: (rows: unknown[]) => rows,
}));

vi.mock("@/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: async () => "fake-jwt",
}));

import { runAbuseRecomputeNightly } from "@/inngest/abuse-recompute-nightly";

const ORIG_STAGING = process.env.STAGING_MODE;
const ORIG_RAG_URL = process.env.RAG_SERVICE_URL;

beforeEach(() => {
  mocks.tenantRows = [];
  mocks.tierRows = [];
  mocks.tierError = null;
  mocks.stateCalls = [];
  delete process.env.STAGING_MODE;
  // Unset so fetchRagTenantChunkCounts early-returns instead of doing network.
  delete process.env.RAG_SERVICE_URL;
});

afterEach(() => {
  if (ORIG_STAGING === undefined) delete process.env.STAGING_MODE;
  else process.env.STAGING_MODE = ORIG_STAGING;
  if (ORIG_RAG_URL === undefined) delete process.env.RAG_SERVICE_URL;
  else process.env.RAG_SERVICE_URL = ORIG_RAG_URL;
  vi.restoreAllMocks();
});

describe("abuse-recompute-nightly — batched tier lookup", () => {
  it("resolves each tenant to its OWN tier_code (the Map must not cross-assign)", async () => {
    mocks.tenantRows = [
      { id: "tenant-a", tier_id: "tier-1" },
      { id: "tenant-b", tier_id: "tier-2" },
      { id: "tenant-c", tier_id: "tier-3" },
    ];
    // Deliberately not in tenant order — a Map keyed correctly is order-
    // independent; positional/index-based assignment would fail here.
    mocks.tierRows = [
      { id: "tier-2", code: "sub_agency" },
      { id: "tier-3", code: "byo_professional" },
      { id: "tier-1", code: "sub_pro" },
    ];

    await runAbuseRecomputeNightly();

    expect(mocks.stateCalls).toEqual([
      { tenant_id: "tenant-a", tier_code: "sub_pro" },
      { tenant_id: "tenant-b", tier_code: "sub_agency" },
      { tenant_id: "tenant-c", tier_code: "byo_professional" },
    ]);
  });

  it("falls back to byo_research for null and unknown tier_ids without disturbing its neighbours", async () => {
    mocks.tenantRows = [
      { id: "tenant-null", tier_id: null },
      { id: "tenant-paying", tier_id: "tier-1" },
      { id: "tenant-unknown", tier_id: "tier-missing" },
    ];
    mocks.tierRows = [{ id: "tier-1", code: "sub_agency" }];

    await runAbuseRecomputeNightly();

    expect(mocks.stateCalls).toEqual([
      { tenant_id: "tenant-null", tier_code: "byo_research" },
      // The real point: one unresolvable neighbour must not drag a paying
      // tenant down to the lowest tier.
      { tenant_id: "tenant-paying", tier_code: "sub_agency" },
      { tenant_id: "tenant-unknown", tier_code: "byo_research" },
    ]);
  });

  it("THROWS when the tier_definitions read fails instead of defaulting everyone to byo_research", async () => {
    // Regression guard: reverting to `const { data: tierRows } = await ...`
    // (error discarded) makes this test fail — the run would complete with
    // every tenant silently mis-tiered to the lowest tier and enforced
    // against. Throwing lets Inngest retry the run instead.
    mocks.tenantRows = [
      { id: "tenant-a", tier_id: "tier-1" },
      { id: "tenant-b", tier_id: "tier-2" },
    ];
    mocks.tierError = {
      message: "connection reset by peer",
      code: "08006",
      hint: null,
      details: null,
      name: "PostgrestError",
    };

    await expect(runAbuseRecomputeNightly()).rejects.toThrow(/tier_definitions\.select\.batch/);
    expect(mocks.stateCalls).toEqual([]);
  });
});
