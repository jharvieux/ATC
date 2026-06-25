// #1386 / F-tok-01 — DB-backed rate limit on the public-chat route.
//
// Pins WHY the DB counter exists: the old per-instance Map<string, number[]>
// was invisible to other Fluid Compute instances — a burst of requests spread
// across warm instances could each see 0 messages in their local Map and allow
// well over 30 messages/hour. The DB counter is authoritative across all
// instances and enforces the cap consistently.
//
// Critical test: when the DB message count >= 30, the route must return 429
// before ever reaching the LLM or inserting a new message.

import { describe, it, expect, vi } from "vitest";

// ── token we'll use in all tests ────────────────────────────────────────────
const TEST_TOKEN = "test-public-token-abc123";

// ── mock conversation row returned by the first DB query ────────────────────
const CONV_ID = "00000000-0000-0000-0000-000000000001";

// We need to control how many recent messages the second DB query reports.
// The DB chain for the rate-limit path:
//   svc.from("conversations").select("id").eq(...).eq(...).maybeSingle()
//     → { data: { id: CONV_ID } }
//   svc.from("messages").select("id", {count:"exact",head:true}).eq(...).eq(...).eq(...).gte(...)
//     → { count: <recentCount> }
//
// We detect which table is being queried by the argument to `.from()`.

// Fluent builder for a Supabase query chain. Every intermediate method returns
// `chain` so callers can keep chaining. Terminal methods (maybeSingle, single,
// limit, gte) return Promises so the route can `await` them.
function makeConvChain(row: unknown) {
  const chain = {
    select: (..._a: unknown[]) => chain,
    eq:     (..._a: unknown[]) => chain,
    maybeSingle: async () => ({ data: row, error: null }),
    single:      async () => ({ data: row, error: null }),
    insert: (..._a: unknown[]) => ({
      select: (..._b: unknown[]) => ({ single: async () => ({ data: row, error: null }) }),
    }),
    update: (..._a: unknown[]) => ({
      eq: (..._b: unknown[]) => ({ eq: (..._c: unknown[]) => Promise.resolve({ data: null, error: null }) }),
    }),
  };
  return chain;
}

function makeMessageChain(recentCount: number) {
  // Handles two call patterns:
  //   (a) rate-limit:        .select("id", {count,head}).eq.eq.eq.gte(...)  → { count: N }
  //   (b) loadHistoryForToken: .select(cols).eq.eq.in.order.limit(n)        → { data: [] }
  //   (c) insert / update
  const deepChain = {
    eq:    (..._a: unknown[]) => deepChain,
    in:    (..._a: unknown[]) => deepChain,
    order: (..._a: unknown[]) => deepChain,
    limit: async (..._a: unknown[]) => ({ data: [], error: null }),
    gte:   async (..._a: unknown[]) => ({ count: recentCount, error: null }),
  };
  return {
    select: (..._a: unknown[]) => deepChain,
    insert: (..._a: unknown[]) => Promise.resolve({ data: [{ id: "msg-1" }], error: null }),
    update: (..._a: unknown[]) => ({
      eq: (..._b: unknown[]) => ({ eq: (..._c: unknown[]) => Promise.resolve({ data: null, error: null }) }),
    }),
  };
}

function makeServiceRoleClient(recentMessageCount: number) {
  return {
    from(table: string) {
      if (table === "conversations") return makeConvChain({ id: CONV_ID });
      if (table === "messages")      return makeMessageChain(recentMessageCount);
      return makeConvChain(null); // quotes / trip_itineraries (handled by mock resolver)
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: null }) }) },
  };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/chat/public-token-resolver", () => ({
  resolvePublicToken: async () => ({
    kind: "quote",
    quote_id: "q1",
    tenant_id: "tenant-1",
    status: "sent",
  }),
  isPublicTokenViewable: () => true,
}));

vi.mock("@/lib/chat/customer-context", () => ({
  resolveCustomerContext: async () => "Customer: Test customer.",
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: async () => ({ text: "Hello from AI" }),
  AiCostHardStateError: class extends Error {},
}));

vi.mock("@/lib/db/factories", () => ({
  tenantContextForPublicTokenChat: () => ({}),
}));

vi.mock("@/lib/supervisor/run-supervisor", () => ({
  runSupervisor: async () => ({ action: "allow" }),
  HATE_SPEECH_REGEN_INSTRUCTION: "Regen",
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  loadTenantSnapshot: async () => ({
    tenant: { id: "tenant-1", tier_code: "sub_starter" },
    ai_cost_state: "ok",
    chat_volume_state: "ok",
    email_volume_state: "ok",
    group_invite_state: "ok",
    rag_chunk_count_state: "ok",
    rag_storage_state: "ok",
  }),
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  evictTenantSnapshot: () => {},
  _resetSnapshotCacheForTests: () => {},
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async () => undefined,
}));

vi.mock("@/lib/vendor-health/registry", () => ({
  recordVendorSuccess: () => undefined,
  recordVendorFailure: () => undefined,
}));

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { POST } from "@/app/api/public/chat/[token]/route";

function makeRequest(message = "Hello"): [Request, { params: Promise<{ token: string }> }] {
  return [
    new Request("http://localhost/api/public/chat/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }),
    { params: Promise.resolve({ token: TEST_TOKEN }) },
  ];
}

describe("public-chat DB-backed rate limit (#1386 / F-tok-01)", () => {
  it("allows a message when recent DB message count is below the cap (< 30)", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeServiceRoleClient(5) as unknown as ReturnType<typeof createServiceRoleClient>,
    );
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).not.toBe(429);
  });

  it("returns 429 rate_limit_exceeded when DB message count is at the cap (>= 30)", async () => {
    // WHY: the DB counter is authoritative across all Fluid Compute instances.
    // When count >= 30, the route must refuse BEFORE calling the LLM.
    // A regression back to a per-instance Map would break cross-instance enforcement.
    vi.mocked(createServiceRoleClient).mockReturnValue(
      makeServiceRoleClient(30) as unknown as ReturnType<typeof createServiceRoleClient>,
    );
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(429);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("rate_limit_exceeded");
  });

  it("allows a message when no conversation exists yet (first-ever message, count treated as 0)", async () => {
    // A brand-new token has no conversation row; the rate-limit check is skipped entirely.
    const convChainNoRow = {
      select: (..._a: unknown[]) => convChainNoRow,
      eq:     (..._a: unknown[]) => convChainNoRow,
      maybeSingle: async () => ({ data: null, error: null }),
      single:      async () => ({ data: null, error: null }),
      insert: (..._a: unknown[]) => ({
        select: (..._b: unknown[]) => ({ single: async () => ({ data: { id: CONV_ID }, error: null }) }),
      }),
      update: (..._a: unknown[]) => ({
        eq: (..._b: unknown[]) => ({ eq: (..._c: unknown[]) => Promise.resolve({ data: null, error: null }) }),
      }),
    };
    const clientWithNoConv = {
      from(table: string) {
        if (table === "conversations") return convChainNoRow;
        if (table === "messages")      return makeMessageChain(0);
        return makeConvChain(null);
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
      storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: null }) }) },
    };
    vi.mocked(createServiceRoleClient).mockReturnValue(
      clientWithNoConv as unknown as ReturnType<typeof createServiceRoleClient>,
    );
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).not.toBe(429);
  });
});
