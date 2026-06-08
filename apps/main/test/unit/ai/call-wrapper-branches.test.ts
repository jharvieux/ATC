// AI call-wrapper — branch coverage for selectModelForPurpose, payload
// shape assertions, vendor-health recording, and the state-transition
// fire-and-forget. The sibling call-wrapper-hard-state.test.ts covers the
// D-091 R3 #56/#58 enforcement; this file fills the gap mutation testing
// flagged on the rest of the wrapper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. selectModelForPurpose — pure function. No mocks needed.
// ---------------------------------------------------------------------------

describe("selectModelForPurpose", () => {
  it("returns desired model when ai_cost_state='ok' (no downgrade)", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "memory_extraction",
        ai_cost_state: "ok",
      }),
    ).toBe("claude-opus-4-7");
  });

  it("returns desired model when ai_cost_state='hard' (hard is enforced upstream by throw — selector returns the unchanged model)", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "memory_extraction",
        ai_cost_state: "hard",
      }),
    ).toBe("claude-opus-4-7");
  });

  it("on soft1: downgrades non-customer-facing purpose claude-opus-4-7 → claude-haiku-4-5-20251001", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "memory_extraction",
        ai_cost_state: "soft1",
      }),
    ).toBe("claude-haiku-4-5-20251001");
  });

  it("on soft1: downgrades non-customer-facing claude-sonnet-4-6 → claude-haiku-4-5-20251001", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-sonnet-4-6",
        purpose: "rag_normalization",
        ai_cost_state: "soft1",
      }),
    ).toBe("claude-haiku-4-5-20251001");
  });

  it("on soft2: same downgrade path applies", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "rag_relevance_scoring",
        ai_cost_state: "soft2",
      }),
    ).toBe("claude-haiku-4-5-20251001");
  });

  it("on soft1: customer-facing purpose 'chat_main' is NOT downgraded", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "chat_main",
        ai_cost_state: "soft1",
      }),
    ).toBe("claude-opus-4-7");
  });

  it("on soft1: customer-facing 'precruise_generation' is NOT downgraded", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "precruise_generation",
        ai_cost_state: "soft1",
      }),
    ).toBe("claude-opus-4-7");
  });

  it("on soft1: customer-facing 'quote_narrative' is NOT downgraded", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-opus-4-7",
        purpose: "quote_narrative",
        ai_cost_state: "soft1",
      }),
    ).toBe("claude-opus-4-7");
  });

  it("on soft1: model not in DOWNGRADE_MAP returns unchanged (no downgrade path defined)", async () => {
    const { selectModelForPurpose } = await import("@/lib/ai/call-wrapper");
    expect(
      selectModelForPurpose({
        desired_model: "claude-haiku-4-5-20251001",
        purpose: "memory_extraction",
        ai_cost_state: "soft1",
      }),
    ).toBe("claude-haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// 2. instrumentedClaudeCall — payload + side-effect assertions.
// ---------------------------------------------------------------------------

type DbCall = { table?: string; op: string; payload: unknown };
let dbCalls: DbCall[];
let rpcCalls: Array<{ fn: string; args: unknown }>;
let vendorSuccessCalls: string[];
let vendorFailureCalls: Array<{ vendor: string; msg: string }>;
let stateTransitionCalls: number;
let anthropicCreateArgs: unknown;
let openaiCreateArgs: unknown;
let anthropicShouldThrow = false;
let openaiShouldThrow = false;

const mocks = vi.hoisted(() => ({
  aiCostState: "ok" as "ok" | "soft1" | "soft2" | "hard",
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  loadTenantSnapshot: async (_db: unknown, tenant_id: string) => ({
    tenant: { id: tenant_id, tier_code: "sub_starter" },
    ai_cost_state: mocks.aiCostState,
    chat_volume_state: "ok",
    email_volume_state: "ok",
    group_invite_state: "ok",
    rag_chunk_count_state: "ok",
    rag_storage_state: "ok",
  }),
  _resetSnapshotCacheForTests: () => {},
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      return {
        insert(payload: unknown) {
          dbCalls.push({ table, op: "insert", payload });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

vi.mock("@/lib/ai/pricing", () => ({
  primePricingCache: async () => undefined,
  getCostEstimate: ({ input_tokens, output_tokens }: { input_tokens: number; output_tokens: number }) =>
    BigInt(input_tokens + output_tokens), // cents = total tokens (test fixture)
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      create: async (args: unknown) => {
        anthropicCreateArgs = args;
        if (anthropicShouldThrow) throw new Error("anthropic api down");
        return {
          content: [{ type: "text", text: "hello world" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };
  },
}));

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    embeddings = {
      create: async (args: unknown) => {
        openaiCreateArgs = args;
        if (openaiShouldThrow) throw new Error("openai api down");
        return {
          data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }],
          usage: { prompt_tokens: 7 },
        };
      },
    };
  },
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async () => {
    stateTransitionCalls += 1;
  },
}));

vi.mock("@/lib/vendor-health/registry", () => ({
  recordVendorSuccess: (v: string) => {
    vendorSuccessCalls.push(v);
  },
  recordVendorFailure: (v: string, msg: string) => {
    vendorFailureCalls.push({ vendor: v, msg });
  },
}));

import {
  AiCostHardStateError,
  instrumentedClaudeCall,
  instrumentedOpenAIEmbedding,
  PLATFORM_TENANT_ID,
} from "@/lib/ai/call-wrapper";

const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const ORIG_OPENAI = process.env.OPENAI_API_KEY;

beforeEach(() => {
  dbCalls = [];
  rpcCalls = [];
  vendorSuccessCalls = [];
  vendorFailureCalls = [];
  stateTransitionCalls = 0;
  anthropicCreateArgs = undefined;
  openaiCreateArgs = undefined;
  anthropicShouldThrow = false;
  openaiShouldThrow = false;
  mocks.aiCostState = "ok";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  if (ORIG_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC;
  if (ORIG_OPENAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIG_OPENAI;
  vi.restoreAllMocks();
});

describe("instrumentedClaudeCall — happy path", () => {
  it("throws when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      instrumentedClaudeCall({
        tenant_id: "t-1",
        model: "claude-haiku-4-5-20251001",
        purpose: "memory_extraction",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("passes model + max_tokens + messages through to the Anthropic SDK call", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    // #851 — the chain tries the undated "latest" alias first; the pinned id the
    // caller passed is the in-tier fallback, so the SDK call uses the alias.
    expect(anthropicCreateArgs).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("includes `system` only when provided (not even an empty string key)", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect("system" in (anthropicCreateArgs as Record<string, unknown>)).toBe(false);

    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      system: "you are a helper",
      messages: [{ role: "user", content: "hi" }],
    });
    // §9.3 — prompt caching wraps the system string into a block array with
    // a cache_control marker. The original intent of this test was "system
    // arg is forwarded when provided"; assertion updated to read the wrapped
    // text. Plain-string mode is exercised separately by build-system-arg.test.ts.
    const systemArg = (anthropicCreateArgs as { system?: unknown }).system;
    expect(Array.isArray(systemArg)).toBe(true);
    expect((systemArg as Array<{ text: string }>)[0]?.text).toBe("you are a helper");
  });

  it("downgrades the actual SDK-call model when ai_cost_state='soft1' for non-customer-facing purpose", async () => {
    mocks.aiCostState = "soft1";
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-opus-4-7",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    // #851 — soft1 downgrades opus → haiku tier; the chain then tries the haiku
    // "latest" alias first, so the SDK call uses claude-haiku-4-5.
    expect((anthropicCreateArgs as { model: string }).model).toBe("claude-haiku-4-5");
  });

  it("does NOT downgrade the SDK-call model for customer-facing 'chat_main' on soft1", async () => {
    mocks.aiCostState = "soft1";
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-opus-4-7",
      purpose: "chat_main",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect((anthropicCreateArgs as { model: string }).model).toBe("claude-opus-4-7");
  });

  it("returns the concatenated text + raw response", async () => {
    const result = await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("hello world");
    expect(result.raw.content).toBeDefined();
  });

  it("records vendor success on successful Anthropic call", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(vendorSuccessCalls).toContain("anthropic");
    expect(vendorFailureCalls).toHaveLength(0);
  });

  it("records vendor FAILURE and re-throws when the Anthropic SDK throws", async () => {
    anthropicShouldThrow = true;
    await expect(
      instrumentedClaudeCall({
        tenant_id: "t-1",
        model: "claude-haiku-4-5-20251001",
        purpose: "memory_extraction",
        max_tokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("anthropic api down");
    // #851 — the chain tries every model (alias then pinned) before re-throwing,
    // recording a vendor failure per attempt. Both haiku entries failed here.
    expect(vendorFailureCalls).toEqual([
      { vendor: "anthropic", msg: "anthropic api down" },
      { vendor: "anthropic", msg: "anthropic api down" },
    ]);
    expect(vendorSuccessCalls).toHaveLength(0);
  });

  it("writes an ai_call_log row with vendor='anthropic' and per-call attribution fields", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      conversation_id: "conv-9",
      user_id: "usr-42",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    const log = dbCalls.find((c) => c.table === "ai_call_log");
    expect(log).toBeDefined();
    const p = log!.payload as Record<string, unknown>;
    expect(p.tenant_id).toBe("t-1");
    expect(p.conversation_id).toBe("conv-9");
    expect(p.user_id).toBe("usr-42");
    expect(p.vendor).toBe("anthropic");
    expect(p.purpose).toBe("memory_extraction");
    expect(p.input_tokens).toBe(10);
    expect(p.output_tokens).toBe(5);
    expect(p.cost_estimate_cents).toBe("15"); // fixture: cost = input + output = 15
  });

  it("ai_call_log row has conversation_id=null and user_id=null when not provided", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    const log = dbCalls.find((c) => c.table === "ai_call_log");
    const p = log!.payload as Record<string, unknown>;
    expect(p.conversation_id).toBeNull();
    expect(p.user_id).toBeNull();
  });

  it("invokes increment_tenant_ai_cost RPC with tenant_id, billing-period DATERANGE literal, and amount", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    const rpc = rpcCalls.find((c) => c.fn === "increment_tenant_ai_cost");
    expect(rpc).toBeDefined();
    const a = rpc!.args as Record<string, unknown>;
    expect(a.p_tenant_id).toBe("t-1");
    expect(a.p_amount_cents).toBe("15");
    expect(a.p_billing_period).toMatch(/^\[\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}\)$/);
  });

  it("does NOT call the metrics RPC for PLATFORM_TENANT_ID (cross-tenant platform calls)", async () => {
    await instrumentedClaudeCall({
      tenant_id: PLATFORM_TENANT_ID,
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(rpcCalls.some((c) => c.fn === "increment_tenant_ai_cost")).toBe(false);
    // ai_call_log row still gets written (cost attribution required for platform usage too)
    expect(dbCalls.some((c) => c.table === "ai_call_log")).toBe(true);
  });

  it("fires the state-transition check after the call (fire-and-forget)", async () => {
    await instrumentedClaudeCall({
      tenant_id: "t-1",
      model: "claude-haiku-4-5-20251001",
      purpose: "memory_extraction",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    // Fire-and-forget: at least started. Allow microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(stateTransitionCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. instrumentedOpenAIEmbedding — happy path
// ---------------------------------------------------------------------------

describe("instrumentedOpenAIEmbedding — happy path", () => {
  it("throws when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      instrumentedOpenAIEmbedding({
        tenant_id: "t-1",
        model: "text-embedding-3-small",
        input: "hello",
        purpose: "embedding",
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("passes model + input through to the OpenAI SDK call", async () => {
    await instrumentedOpenAIEmbedding({
      tenant_id: "t-1",
      model: "text-embedding-3-large",
      input: ["a", "b"],
      purpose: "embedding",
    });
    expect(openaiCreateArgs).toMatchObject({
      model: "text-embedding-3-large",
      input: ["a", "b"],
    });
  });

  it("returns the embedding vectors from response.data[].embedding", async () => {
    const r = await instrumentedOpenAIEmbedding({
      tenant_id: "t-1",
      model: "text-embedding-3-small",
      input: ["a", "b"],
      purpose: "embedding",
    });
    expect(r.embeddings).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("records vendor success on success", async () => {
    await instrumentedOpenAIEmbedding({
      tenant_id: "t-1",
      model: "text-embedding-3-small",
      input: "hello",
      purpose: "embedding",
    });
    expect(vendorSuccessCalls).toContain("openai");
    expect(vendorFailureCalls).toHaveLength(0);
  });

  it("records vendor failure and re-throws when the OpenAI SDK throws", async () => {
    openaiShouldThrow = true;
    await expect(
      instrumentedOpenAIEmbedding({
        tenant_id: "t-1",
        model: "text-embedding-3-small",
        input: "hello",
        purpose: "embedding",
      }),
    ).rejects.toThrow("openai api down");
    expect(vendorFailureCalls).toEqual([{ vendor: "openai", msg: "openai api down" }]);
    expect(vendorSuccessCalls).toHaveLength(0);
  });

  it("writes an ai_call_log row with vendor='openai', output_tokens=0", async () => {
    await instrumentedOpenAIEmbedding({
      tenant_id: "t-1",
      model: "text-embedding-3-small",
      input: "hello",
      purpose: "embedding",
    });
    const log = dbCalls.find((c) => c.table === "ai_call_log");
    expect(log).toBeDefined();
    const p = log!.payload as Record<string, unknown>;
    expect(p.vendor).toBe("openai");
    expect(p.model).toBe("text-embedding-3-small");
    expect(p.input_tokens).toBe(7);
    expect(p.output_tokens).toBe(0);
  });

  it("PLATFORM_TENANT_ID skips snapshot load entirely and skips the metrics RPC", async () => {
    // Set hard state — if the snapshot were loaded, this would throw.
    // PLATFORM_TENANT_ID should bypass both the load and the metrics increment.
    mocks.aiCostState = "hard";
    const r = await instrumentedOpenAIEmbedding({
      tenant_id: PLATFORM_TENANT_ID,
      model: "text-embedding-3-small",
      input: "hello",
      purpose: "embedding",
    });
    expect(r.embeddings).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(rpcCalls.some((c) => c.fn === "increment_tenant_ai_cost")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. AiCostHardStateError shape — survivors at L42-44 (constructor + message).
// ---------------------------------------------------------------------------

describe("AiCostHardStateError", () => {
  it("has the expected code, name, and message format", () => {
    const err = new AiCostHardStateError("tenant-X", "memory_extraction");
    expect(err.code).toBe("ai_cost_hard_state");
    expect(err.name).toBe("AiCostHardStateError");
    expect(err.tenant_id).toBe("tenant-X");
    expect(err.purpose).toBe("memory_extraction");
    expect(err.message).toContain("tenant-X");
    expect(err.message).toContain("memory_extraction");
    expect(err.message).toContain("AI cost limit");
  });

  it("is an instance of Error (extends Error correctly)", () => {
    const err = new AiCostHardStateError("t", "embedding");
    expect(err).toBeInstanceOf(Error);
  });
});
