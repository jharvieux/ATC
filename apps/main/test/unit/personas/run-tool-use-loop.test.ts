// §9.6 — runToolUseLoop: follow-up message construction + dispatch fan-out.
//
// WHY these tests matter: the loop is the seam that turns a model's tool_use
// blocks into (a) dispatched side-effects and (b) the exact message array the
// follow-up Anthropic call must receive. If the follow-up shape drifts — wrong
// role ordering, dropped assistant tool_use content, or a tool_result whose
// tool_use_id doesn't match — Anthropic rejects the follow-up turn at runtime
// and the customer sees a dead chat. None of that is caught by typecheck, so it
// has to be pinned here. The non-streaming AND the new (#421) streaming branch
// both depend on this contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnthropicMessage,
  AnthropicContentBlockParam,
} from "@/lib/ai/call-wrapper";
import type { ToolResult } from "@/lib/personas/tools/dispatch";

// dispatchTool is the only collaborator. Mock it so we control was_mutating /
// content per tool and can assert the exact (name, input, ctx) it was called
// with — including the tool_use_id passed through from each block.
const dispatchCalls: Array<{
  name: string;
  input: Record<string, unknown>;
  tool_use_id: string | undefined;
  conversation_id: string;
  contact_id: string | null | undefined;
}> = [];
let dispatchResponses: Record<string, ToolResult>;

vi.mock("@/lib/personas/tools/dispatch", () => ({
  dispatchTool: async (
    name: string,
    input: Record<string, unknown>,
    dispatchCtx: {
      tool_use_id?: string;
      conversation_id: string;
      contact_id?: string | null;
    },
  ): Promise<ToolResult> => {
    dispatchCalls.push({
      name,
      input,
      tool_use_id: dispatchCtx.tool_use_id,
      conversation_id: dispatchCtx.conversation_id,
      contact_id: dispatchCtx.contact_id,
    });
    return (
      dispatchResponses[name] ?? {
        content: JSON.stringify({ ok: true, tool: name }),
        was_mutating: false,
      }
    );
  },
}));

import { runToolUseLoop } from "@/lib/personas/tools/run-tool-use-loop";

const CONVERSATION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONTACT = "99999999-8888-7777-6666-555555555555";

// Minimal TenantContext — the loop only forwards it untouched to dispatchTool,
// which is mocked, so the shape past tenant_id is irrelevant here.
const dispatchCtx = {
  ctx: { tenant_id: "t-1", source: { kind: "http_request" as const, user_id: "u-1" } },
  db: {} as never,
  conversation_id: CONVERSATION,
  contact_id: CONTACT,
};

function makeRaw(content: AnthropicContentBlockParam[]): AnthropicMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content,
  } as unknown as AnthropicMessage;
}

const originalMessages: Array<{
  role: "user" | "assistant";
  content: string | AnthropicContentBlockParam[];
}> = [{ role: "user", content: "Tell me about my last booking" }];

beforeEach(() => {
  dispatchCalls.length = 0;
  dispatchResponses = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runToolUseLoop — no tool_use", () => {
  it("returns null when the message has only text blocks (common case)", async () => {
    const raw = makeRaw([{ type: "text", text: "Sure, here's an idea." }]);
    const out = await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });
    expect(out).toBeNull();
    expect(dispatchCalls).toHaveLength(0);
  });
});

describe("runToolUseLoop — single tool_use", () => {
  it("dispatches the tool and returns Anthropic-shaped follow-up messages", async () => {
    dispatchResponses["get_customer_context"] = {
      content: JSON.stringify({ name: "Ada", tier: "gold" }),
      was_mutating: false,
    };
    const raw = makeRaw([
      { type: "text", text: "Let me pull that up." },
      {
        type: "tool_use",
        id: "tu_ctx",
        name: "get_customer_context",
        input: { contact_id: CONTACT },
      } as unknown as AnthropicContentBlockParam,
    ]);

    const out = await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });
    expect(out).not.toBeNull();

    // 1. dispatched exactly the tool the model asked for, with its input +
    //    the block's tool_use_id threaded through for audit correlation.
    expect(dispatchCalls).toEqual([
      {
        name: "get_customer_context",
        input: { contact_id: CONTACT },
        tool_use_id: "tu_ctx",
        conversation_id: CONVERSATION,
        contact_id: CONTACT,
      },
    ]);
    expect(out!.dispatchedTools).toEqual(["get_customer_context"]);

    // 2. follow-up = [original..., assistant(raw.content), user(tool_results)].
    //    Anthropic requires the assistant tool_use turn to be echoed back
    //    verbatim before the tool_result user turn.
    expect(out!.followUpMessages).toHaveLength(3);
    expect(out!.followUpMessages[0]).toEqual(originalMessages[0]);

    const assistantTurn = out!.followUpMessages[1]!;
    expect(assistantTurn.role).toBe("assistant");
    expect(assistantTurn.content).toBe(raw.content);

    const userTurn = out!.followUpMessages[2]!;
    expect(userTurn.role).toBe("user");
    const toolResults = userTurn.content as AnthropicContentBlockParam[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_ctx", // MUST match the source block id or Anthropic 400s
      content: JSON.stringify({ name: "Ada", tier: "gold" }),
    });
  });

  it("does not mutate the caller's originalMessages array", async () => {
    const raw = makeRaw([
      { type: "tool_use", id: "tu_1", name: "get_customer_context", input: {} } as unknown as AnthropicContentBlockParam,
    ]);
    const out = await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });
    expect(originalMessages).toHaveLength(1); // untouched
    expect(out!.followUpMessages).toHaveLength(3);
  });

  it("passes {} to the handler when the block.input is undefined", async () => {
    const raw = makeRaw([
      { type: "tool_use", id: "tu_noinput", name: "escalate_to_human" } as unknown as AnthropicContentBlockParam,
    ]);
    await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });
    expect(dispatchCalls[0]?.input).toEqual({});
  });
});

describe("runToolUseLoop — mutated flag", () => {
  it("mutated=true when any dispatched handler reports was_mutating", async () => {
    dispatchResponses["update_memory"] = {
      content: JSON.stringify({ ok: true }),
      was_mutating: true,
    };
    const raw = makeRaw([
      { type: "tool_use", id: "tu_mem", name: "update_memory", input: { content: "likes balconies" } } as unknown as AnthropicContentBlockParam,
    ]);
    const out = await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });
    expect(out!.mutated).toBe(true);
  });

  it("mutated=false when no dispatched handler mutated state", async () => {
    dispatchResponses["get_customer_context"] = {
      content: "{}",
      was_mutating: false,
    };
    const raw = makeRaw([
      { type: "tool_use", id: "tu_ctx", name: "get_customer_context", input: {} } as unknown as AnthropicContentBlockParam,
    ]);
    const out = await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });
    expect(out!.mutated).toBe(false);
  });
});

describe("runToolUseLoop — multiple tool_use blocks", () => {
  it("dispatches each block in order and emits one tool_result per block", async () => {
    dispatchResponses["get_customer_context"] = { content: "ctx", was_mutating: false };
    dispatchResponses["update_memory"] = { content: "mem", was_mutating: true };
    const raw = makeRaw([
      { type: "text", text: "Working on it." },
      { type: "tool_use", id: "tu_a", name: "get_customer_context", input: { a: 1 } } as unknown as AnthropicContentBlockParam,
      { type: "tool_use", id: "tu_b", name: "update_memory", input: { b: 2 } } as unknown as AnthropicContentBlockParam,
    ]);

    const out = await runToolUseLoop({ result: { raw }, originalMessages, dispatchCtx });

    expect(out!.dispatchedTools).toEqual(["get_customer_context", "update_memory"]);
    expect(out!.mutated).toBe(true); // second block mutated

    const toolResults = out!.followUpMessages[2]!.content as AnthropicContentBlockParam[];
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map((r) => (r as { tool_use_id: string }).tool_use_id)).toEqual([
      "tu_a",
      "tu_b",
    ]);
    expect((toolResults[0] as { content: string }).content).toBe("ctx");
    expect((toolResults[1] as { content: string }).content).toBe("mem");
  });
});
