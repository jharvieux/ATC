// #866 — instrumentedClaudeStream must enforce ai_cost_state='hard'.
// Before this fix streaming chat bypassed the circuit-breaker that
// instrumentedClaudeCall had; a tenant in hard state could keep generating
// streamed responses indefinitely. The TA-mode streaming surface (#902)
// raised the priority since it added a new streaming path.
//
// WHY the check must be in the wrapper (not just the chat route):
// Any future streaming caller inherits the gate for free. Callers can't
// opt out — the only correct behavior for hard state is denial.

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ aiCostState: "ok" as "ok" | "soft1" | "soft2" | "hard" }));

vi.mock("@/lib/abuse/snapshot", () => ({
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  loadTenantSnapshot: async () => ({
    tenant: { id: "tenant-1", tier_code: "sub_starter" },
    ai_cost_state: h.aiCostState,
    chat_volume_state: "ok",
    email_volume_state: "ok",
    group_invite_state: "ok",
    rag_chunk_count_state: "ok",
    rag_storage_state: "ok",
  }),
  evictTenantSnapshot: () => {},
}));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      insert: () => Promise.resolve({ data: null, error: null }),
    }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}));
vi.mock("./pricing", () => ({ primePricingCache: async () => undefined, getCostEstimate: () => 0n }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      stream: () => {
        throw new Error("anthropic should never be called in hard state");
      },
    };
  },
}));

// The wrapper checks ANTHROPIC_API_KEY synchronously at call time.
process.env.ANTHROPIC_API_KEY = "test-key";

import { instrumentedClaudeStream } from "@/lib/ai/stream-wrapper";
import { AiCostHardStateError } from "@/lib/ai/call-wrapper";

const BASE_ARGS = {
  tenant_id: "tenant-1",
  model: "claude-haiku-4-5-20251001",
  purpose: "chat_main" as const,
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("instrumentedClaudeStream hard-state gate (#866)", () => {
  it("hard state → done rejects with AiCostHardStateError before calling Anthropic", async () => {
    h.aiCostState = "hard";
    const { done } = instrumentedClaudeStream(BASE_ARGS);
    await expect(done).rejects.toThrow(AiCostHardStateError);
  });

  it("hard state — textStream throws before yielding anything", async () => {
    h.aiCostState = "hard";
    const { textStream, done } = instrumentedClaudeStream(BASE_ARGS);
    // Suppress the unhandled rejection on `done` — we're only testing textStream.
    done.catch(() => {});
    const iter = textStream[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(AiCostHardStateError);
  });

  it("PLATFORM_TENANT_ID is exempt from the hard-state gate", async () => {
    h.aiCostState = "hard";
    // The stream should START (Anthropic mock throws "should never be called"
    // only if construction succeeds — platform tenants get further than the
    // hard-state check before hitting a fake-stream error). We just assert no
    // AiCostHardStateError is thrown.
    const { done } = instrumentedClaudeStream({
      ...BASE_ARGS,
      tenant_id: "00000000-0000-0000-0000-000000000000",
    });
    await expect(done).rejects.not.toThrow(AiCostHardStateError);
  });

  it("ok state → no hard-state error thrown (gate does not fire)", async () => {
    h.aiCostState = "ok";
    const { done } = instrumentedClaudeStream(BASE_ARGS);
    // Anthropic mock throws a different error — but NOT AiCostHardStateError.
    await expect(done).rejects.not.toThrow(AiCostHardStateError);
  });
});
