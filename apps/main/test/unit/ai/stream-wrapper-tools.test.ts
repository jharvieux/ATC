// BP24 §10 / §9.6 — streaming wrapper tool-use plumbing (issue #421).
//
// WHY these tests matter: the streaming chat branch can only emit persona
// tool_use blocks if instrumentedClaudeStream (a) forwards the tool registry
// to anthropic.messages.stream() and (b) exposes the fully-assembled
// finalMessage as `raw` on the `done` promise, because the route's
// runToolUseLoop reads tool_use blocks off `raw`. Neither is provable by
// typecheck — `tools` is an optional field that the wrapper could silently
// drop, and `raw` could be any message. Before #421 the wrapper accepted
// `tools` in its arg type (inherited from InstrumentedClaudeArgs) but never
// passed it through, and discarded everything but text. These tests pin the
// forwarding + raw exposure so a future refactor can't quietly regress chat
// tool-use back to text-only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicTool } from "@/lib/ai/call-wrapper";

// ── Anthropic SDK mock: event-based streaming surface ──
// Captures the args handed to messages.stream() (to assert tool forwarding),
// emits configurable text deltas to the registered "text" listener, then
// resolves (or rejects) finalMessage() with a configurable message.
let streamArgsCapture: Record<string, unknown> | undefined;
let streamDeltas: string[];
let streamFinalMessage: unknown;
let streamShouldThrow: boolean;
let abortCalled: boolean;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      stream: (args: Record<string, unknown>) => {
        streamArgsCapture = args;
        const textCbs: Array<(d: string) => void> = [];
        const handle = {
          on(event: string, cb: (d: string) => void) {
            if (event === "text") textCbs.push(cb);
            return handle;
          },
          abort() {
            abortCalled = true;
          },
          async finalMessage() {
            for (const d of streamDeltas) for (const cb of textCbs) cb(d);
            if (streamShouldThrow) throw new Error("anthropic stream down");
            return streamFinalMessage;
          },
        };
        return handle;
      },
    };
  },
}));

// loadTenantSnapshot + PLATFORM_TENANT_ID resolve through call-wrapper, which
// re-exports them from lib/abuse/snapshot — mock the source (same as the
// call-wrapper unit tests) so no real DB read happens.
vi.mock("@/lib/abuse/snapshot", () => ({
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  loadTenantSnapshot: async (_db: unknown, tenant_id: string) => ({
    tenant: { id: tenant_id, tier_code: "sub_starter" },
    ai_cost_state: "ok",
    chat_volume_state: "ok",
    email_volume_state: "ok",
    group_invite_state: "ok",
    rag_chunk_count_state: "ok",
    rag_storage_state: "ok",
  }),
  _resetSnapshotCacheForTests: () => {},
}));

// Chainable service-role client stub. The done-promise logging path does an
// ai_call_log insert + a tenant_usage_metrics read/insert; all resolve clean.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const builder: Record<string, unknown> = {
      insert: () => Promise.resolve({ data: null, error: null }),
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      update: () => builder,
    };
    return { from: () => builder };
  },
}));

vi.mock("@/lib/ai/pricing", () => ({
  primePricingCache: async () => undefined,
  getCostEstimate: ({ input_tokens, output_tokens }: { input_tokens: number; output_tokens: number }) =>
    BigInt(input_tokens + output_tokens),
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async () => undefined,
}));

let vendorSuccess: string[];
let vendorFailure: Array<{ vendor: string; msg: string }>;
vi.mock("@/lib/vendor-health/registry", () => ({
  recordVendorSuccess: (v: string) => {
    vendorSuccess.push(v);
  },
  recordVendorFailure: (v: string, msg: string) => {
    vendorFailure.push({ vendor: v, msg });
  },
}));

import { instrumentedClaudeStream } from "@/lib/ai/stream-wrapper";

const TOOLS: AnthropicTool[] = [
  {
    name: "get_customer_context",
    description: "Look up the customer's CRM context.",
    input_schema: { type: "object", properties: {} },
  } as unknown as AnthropicTool,
];

function finalMsg(content: unknown[]): unknown {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 8 },
    content,
  };
}

const baseArgs = {
  tenant_id: "t-1",
  conversation_id: "conv-1",
  user_id: "user-1",
  model: "claude-opus-4-7",
  purpose: "chat_main" as const,
  max_tokens: 1024,
  messages: [{ role: "user" as const, content: "What's my booking status?" }],
};

const ORIG_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  streamArgsCapture = undefined;
  streamDeltas = [];
  streamFinalMessage = finalMsg([{ type: "text", text: "Sure." }]);
  streamShouldThrow = false;
  abortCalled = false;
  vendorSuccess = [];
  vendorFailure = [];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});

afterEach(() => {
  if (ORIG_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC;
  vi.restoreAllMocks();
});

describe("instrumentedClaudeStream — tool forwarding (#421)", () => {
  it("forwards the tools registry to messages.stream() when provided", async () => {
    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: TOOLS });
    await done;
    expect(streamArgsCapture).toBeDefined();
    expect(streamArgsCapture!.tools).toEqual(TOOLS);
  });

  it("omits the `tools` key entirely when no tools are passed", async () => {
    const { done } = instrumentedClaudeStream({ ...baseArgs });
    await done;
    expect("tools" in (streamArgsCapture as Record<string, unknown>)).toBe(false);
  });

  it("omits the `tools` key when an empty tools array is passed", async () => {
    // The wrapper guards on `tools.length > 0`; an empty array must NOT send a
    // `tools: []` field (Anthropic rejects an empty tools array).
    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: [] });
    await done;
    expect("tools" in (streamArgsCapture as Record<string, unknown>)).toBe(false);
  });

  it("forwards model, max_tokens, and messages unchanged", async () => {
    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: TOOLS });
    await done;
    expect(streamArgsCapture).toMatchObject({
      model: "claude-opus-4-7",
      max_tokens: 1024,
      messages: [{ role: "user", content: "What's my booking status?" }],
    });
  });
});

describe("instrumentedClaudeStream — raw exposure (#421)", () => {
  it("resolves `done` with `raw` = the assembled finalMessage including tool_use blocks", async () => {
    streamFinalMessage = finalMsg([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "get_customer_context", input: { contact_id: "c1" } },
    ]);

    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: TOOLS });
    const result = await done;

    // raw is what runToolUseLoop reads tool_use blocks off of.
    const toolUse = result.raw.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as { name: string }).name).toBe("get_customer_context");
    expect((toolUse as { input: unknown }).input).toEqual({ contact_id: "c1" });

    // done.text is the text-only concatenation (tool_use blocks excluded).
    expect(result.text).toBe("Let me check.");
  });

  it("reports usage + cost off the finalMessage usage block", async () => {
    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: TOOLS });
    const result = await done;
    expect(result.input_tokens).toBe(12);
    expect(result.output_tokens).toBe(8);
    expect(result.cost_cents).toBe(20n); // fixture: cents = input + output
  });
});

describe("instrumentedClaudeStream — text channel + vendor health", () => {
  it("streams raw text deltas through textStream while done carries canonical text", async () => {
    streamDeltas = ["Hello ", "world."];
    streamFinalMessage = finalMsg([{ type: "text", text: "Hello world." }]);

    const { textStream, done } = instrumentedClaudeStream({ ...baseArgs });
    const collected: string[] = [];
    const consume = (async () => {
      for await (const t of textStream) collected.push(t);
    })();

    const result = await done;
    await consume;

    expect(collected).toEqual(["Hello ", "world."]);
    expect(result.text).toBe("Hello world.");
  });

  it("records vendor success on a clean finish", async () => {
    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: TOOLS });
    await done;
    expect(vendorSuccess).toContain("anthropic");
    expect(vendorFailure).toHaveLength(0);
  });

  it("records vendor failure and rejects `done` when finalMessage throws", async () => {
    streamShouldThrow = true;
    const { done } = instrumentedClaudeStream({ ...baseArgs, tools: TOOLS });
    await expect(done).rejects.toThrow("anthropic stream down");
    expect(vendorFailure).toEqual([{ vendor: "anthropic", msg: "anthropic stream down" }]);
    expect(vendorSuccess).toHaveLength(0);
  });

  it("throws synchronously when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => instrumentedClaudeStream({ ...baseArgs })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("aborts the underlying stream when the caller's signal is already aborted", async () => {
    // The route's streamTurn aborts mid-stream on a per-sentence supervisor
    // hit; this pins that an aborted signal reaches stream.abort().
    const controller = new AbortController();
    controller.abort();
    const { done } = instrumentedClaudeStream({ ...baseArgs, signal: controller.signal });
    await done.catch(() => undefined);
    expect(abortCalled).toBe(true);
  });
});
