// §9.6 — Tool-use loop helper.
//
// Takes an Anthropic Message response, checks for tool_use blocks,
// dispatches each to its handler, and returns the follow-up messages
// the caller should send back to Anthropic. Caller-side glue is then
// just:
//
//   let result = await instrumentedClaudeCall({ ..., tools });
//   const followUp = await runToolUseLoop({ result, dispatchCtx, originalMessages });
//   if (followUp) {
//     result = await instrumentedClaudeCall({ ..., messages: followUp });
//   }
//   // result.text is now the post-tool-use reply.
//
// This intentionally does a SINGLE pass — if the follow-up response
// triggers another tool_use, the caller can decide to loop again (we
// don't loop here because budget / regen-budget interactions belong
// to the caller). For chat, one pass is enough in practice — the LLM
// almost never chains tool calls.

import type {
  AnthropicMessage,
  AnthropicContentBlockParam,
  AnthropicToolResultBlockParam,
  AnthropicToolUseBlock,
} from "@/lib/ai/call-wrapper";
import { dispatchTool, type ToolDispatchContext } from "./dispatch";

export interface ToolLoopInput {
  /** The raw Anthropic Message response from the first call. */
  result: { raw: AnthropicMessage };
  /** Original messages list sent to the first call (so we can append). */
  originalMessages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlockParam[];
  }>;
  /** Context passed to each dispatched tool handler. */
  dispatchCtx: ToolDispatchContext;
}

export interface ToolLoopOutput {
  /** Messages array to send back to Anthropic for the follow-up call. */
  followUpMessages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlockParam[];
  }>;
  /** Names of the tools dispatched (for audit / logging). */
  dispatchedTools: string[];
  /** True if any dispatched tool mutated DB state. */
  mutated: boolean;
}

/**
 * Returns null if the response had no tool_use blocks (caller can
 * proceed with result.text). Otherwise returns the follow-up messages
 * to pass to a second instrumentedClaudeCall.
 */
export async function runToolUseLoop(
  input: ToolLoopInput,
): Promise<ToolLoopOutput | null> {
  const { result, originalMessages, dispatchCtx } = input;
  const toolUseBlocks = extractToolUseBlocks(result.raw);
  if (toolUseBlocks.length === 0) return null;

  const dispatchedTools: string[] = [];
  let mutated = false;
  const toolResults: AnthropicToolResultBlockParam[] = [];

  for (const block of toolUseBlocks) {
    const dispatched = await dispatchTool(
      block.name,
      (block.input ?? {}) as Record<string, unknown>,
      dispatchCtx,
    );
    dispatchedTools.push(block.name);
    if (dispatched.was_mutating) mutated = true;
    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: dispatched.content,
    });
  }

  // Anthropic's tool-use protocol: append the assistant's full content
  // (including the tool_use blocks) as an `assistant` message, then send
  // a `user` message containing the tool_result blocks.
  const followUpMessages: ToolLoopOutput["followUpMessages"] = [
    ...originalMessages,
    {
      role: "assistant",
      content: result.raw.content as AnthropicContentBlockParam[],
    },
    {
      role: "user",
      content: toolResults,
    },
  ];

  return { followUpMessages, dispatchedTools, mutated };
}

function extractToolUseBlocks(
  msg: AnthropicMessage,
): AnthropicToolUseBlock[] {
  return msg.content.filter(
    (b): b is AnthropicToolUseBlock => b.type === "tool_use",
  );
}
