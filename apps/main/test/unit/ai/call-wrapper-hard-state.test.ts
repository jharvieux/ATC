// D-091 Round-3 #56/#58 — instrumented call wrappers fail-closed on
// `hard` ai_cost_state. Pre-fix:
//   - instrumentedClaudeCall only downgraded the model; never refused.
//     The chat route had its own pre-check, but every other caller
//     (supervisor, memory extract, persona screening, etc.) silently
//     allowed calls in hard state.
//   - instrumentedOpenAIEmbedding skipped the snapshot/state check
//     entirely, so hard-state tenants could keep generating embeddings
//     indefinitely.
// Post-fix: both wrappers load the snapshot and throw AiCostHardStateError
// on hard state. PLATFORM_TENANT_ID is exempt (cross-tenant platform calls).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aiCostState: "ok" as "ok" | "soft1" | "soft2" | "hard",
  tenantId: "00000000-0000-0000-0000-000000000001",
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  loadTenantSnapshot: async () => ({
    tenant: { id: mocks.tenantId, tier_code: "sub_starter" },
    ai_cost_state: mocks.aiCostState,
    chat_volume_state: "ok",
    email_volume_state: "ok",
    group_invite_state: "ok",
    rag_chunk_count_state: "ok",
    rag_storage_state: "ok",
  }),
  _resetSnapshotCacheForTests: () => {},
  evictTenantSnapshot: () => {},
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      // Resolve logAndIncrement's writes silently.
      insert: () => Promise.resolve({ data: null, error: null }),
      // RPC for the atomic-increment path (D-094 / Greptile #265 fix).
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}));

vi.mock("./pricing", () => ({
  primePricingCache: async () => undefined,
  getCostEstimate: () => 0n,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      create: async () => ({ content: [{ type: "text", text: "hello" }], usage: { input_tokens: 1, output_tokens: 1 } }),
    };
  },
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    embeddings = {
      create: async () => ({ data: [{ embedding: [0, 0, 0] }], usage: { prompt_tokens: 1 } }),
    };
  },
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async () => undefined,
}));

vi.mock("@/lib/vendor-health/registry", () => ({
  recordVendorSuccess: () => undefined,
  recordVendorFailure: () => undefined,
}));

import {
  AiCostHardStateError,
  instrumentedClaudeCall,
  instrumentedOpenAIEmbedding,
} from "@/lib/ai/call-wrapper";

const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIG_OPENAI = process.env.OPENAI_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-test";
  mocks.aiCostState = "ok";
  mocks.tenantId = "00000000-0000-0000-0000-000000000001";
});

afterEach(() => {
  if (ORIG_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC;
  if (ORIG_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIG_OPENAI;
  vi.restoreAllMocks();
});

describe("instrumentedClaudeCall — hard-state enforcement (D-091 R3 #56)", () => {
  it("throws AiCostHardStateError when tenant is in hard state", async () => {
    mocks.aiCostState = "hard";
    await expect(
      instrumentedClaudeCall({
        tenant_id: "t-1",
        model: "claude-haiku-4-5-20251001",
        purpose: "memory_extraction",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(AiCostHardStateError);
  });

  it("does NOT throw when state is ok / soft1 / soft2", async () => {
    for (const state of ["ok", "soft1", "soft2"] as const) {
      mocks.aiCostState = state;
      const result = await instrumentedClaudeCall({
        tenant_id: "t-1",
        model: "claude-haiku-4-5-20251001",
        purpose: "memory_extraction",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(result.text).toBe("hello");
    }
  });

  it("PLATFORM_TENANT_ID bypasses hard-state enforcement (platform-wide cron embeddings etc.)", async () => {
    mocks.aiCostState = "hard";
    const result = await instrumentedClaudeCall({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("hello");
  });
});

describe("instrumentedOpenAIEmbedding — hard-state enforcement (D-091 R3 #58)", () => {
  it("throws AiCostHardStateError when tenant is in hard state", async () => {
    mocks.aiCostState = "hard";
    await expect(
      instrumentedOpenAIEmbedding({
        tenant_id: "t-1",
        model: "text-embedding-3-small",
        input: "hello",
        purpose: "embedding",
      }),
    ).rejects.toBeInstanceOf(AiCostHardStateError);
  });

  it("does NOT throw when state is ok", async () => {
    mocks.aiCostState = "ok";
    const result = await instrumentedOpenAIEmbedding({
      tenant_id: "t-1",
      model: "text-embedding-3-small",
      input: "hello",
      purpose: "embedding",
    });
    expect(result.embeddings).toEqual([[0, 0, 0]]);
  });

  it("PLATFORM_TENANT_ID bypasses hard-state enforcement", async () => {
    mocks.aiCostState = "hard";
    const result = await instrumentedOpenAIEmbedding({
      tenant_id: "00000000-0000-0000-0000-000000000000",
      model: "text-embedding-3-small",
      input: "hello",
      purpose: "embedding",
    });
    expect(result.embeddings).toEqual([[0, 0, 0]]);
  });
});
