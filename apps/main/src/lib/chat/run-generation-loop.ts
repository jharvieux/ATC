// #1016 — generation machinery, extracted verbatim from handleChat.
//
// Owns one turn's generate → persist-candidate → supervise → regen cycle:
//   • streaming branch (BP24 option B): instrumentedClaudeStream +
//     per-sentence slur check (abort → regen) + single-pass tool dispatch
//   • non-streaming branch: instrumentedClaudeCall + the same single-pass
//     tool-use loop (#421)
//   • multi-attempt regen loop (supervisor-driven, REGEN_HARD_CEILING cap)
//   • vendor-down fallback emission
//
// The caller keeps the orchestration spine: kill switches and vendor gates
// run BEFORE this; escalation handling, asset-id validation, and final
// delivery run AFTER. On the abort paths (vendor down, candidate persist
// failure) this function has already sent the terminal SSE events and
// closed the stream — the caller just returns.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  instrumentedClaudeCall,
  type AnthropicTool,
  type AnthropicMessage,
  type AnthropicContentBlockParam,
} from "@/lib/ai/call-wrapper";
import { instrumentedClaudeStream } from "@/lib/ai/stream-wrapper";
import { bufferToSentences } from "@/lib/ai/sentence-buffer";
import { checkSentence } from "@/lib/supervisor/per-sentence-check";
import type { ToolDefinition } from "@/lib/personas/tools";
import { runToolUseLoop } from "@/lib/personas/tools/run-tool-use-loop";
import {
  runSupervisor,
  HATE_SPEECH_REGEN_INSTRUCTION,
} from "@/lib/supervisor/run-supervisor";
import type { SupervisorOutcome } from "@/lib/supervisor/types";
import type { TenantContext } from "@/lib/db/tenant-context";
import { safeAwait } from "@/lib/db/safe-mutation";

const REGEN_HARD_CEILING = 6; // safety net; budget is also enforced inside supervisor

// The SSE events this loop emits — a structural subset of the route's
// SseEvent union, so the route's `send` is directly assignable.
export type GenerationSseEvent =
  | { type: "delta"; text: string }
  | { type: "delta_start" }
  | { type: "rewriting" }
  // The loop only emits action "allow" (vendor-down fallback); regenerate/
  // escalate summary events are the route's post-loop responsibility.
  | { type: "supervisor"; action: "allow"; regens: number }
  | { type: "error"; message: string }
  | { type: "done" };

type TurnMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlockParam[];
};

export type RunGenerationLoopArgs = {
  svc: SupabaseClient;
  // Always present: anonymous turns get a minimal forged ctx at the route layer.
  ctx: TenantContext;
  tenantId: string;
  conversationId: string;
  conversationContactId: string | null;
  userId: string | null;
  customerEmail: string | null;
  personaSlug: string;
  userMessage: string;
  chatHistory: TurnMessage[];
  systemPrompt: string;
  generationModel: string;
  chatPurpose: "chat_main" | "ta_chat_main";
  streamingEnabled: boolean;
  // Tool set exposed to the model this turn — already filtered by audience +
  // tenant tier at the route layer (selectPersonaTools). BYO/TA turns omit the
  // "our booking system" tools, so the loop must use this, not PERSONA_TOOLS.
  tools: ToolDefinition[];
  slurDenyList: string[];
  retrieval: {
    retrieved_chunk_ids: string[];
    citations: unknown[];
    entities: { intent: string; categories_hint: string[] };
  };
  tenantMaxTone: number;
  tenantAllowProfanity: boolean;
  send: (ev: GenerationSseEvent) => Promise<void>;
  close: () => Promise<void>;
};

export type GenerationLoopResult =
  | {
      status: "complete";
      candidate: string;
      // Both non-null: "complete" means at least one attempt persisted a row
      // and ran the supervisor (the loop aborts otherwise).
      supervisorOutcome: SupervisorOutcome;
      assistantMessageId: string;
      // BP24 telemetry — observability for the streaming-enabled cohort.
      streamedAttempts: number;
      perSentenceFires: number;
      postStreamSupervisorFires: number;
    }
  // Terminal SSE events already sent and the stream closed (vendor-down
  // fallback or candidate-persist failure) — caller returns immediately.
  | { status: "aborted" };

export async function runGenerationLoop(args: RunGenerationLoopArgs): Promise<GenerationLoopResult> {
  const {
    svc,
    ctx,
    tenantId,
    conversationId,
    conversationContactId,
    userId,
    customerEmail,
    personaSlug,
    userMessage,
    chatHistory,
    systemPrompt,
    generationModel,
    chatPurpose,
    streamingEnabled,
    tools,
    slurDenyList,
    retrieval,
    tenantMaxTone,
    tenantAllowProfanity,
    send,
    close,
  } = args;

  let extraInstruction = "";
  let candidate = "";
  let supervisorOutcome: SupervisorOutcome | null = null;
  let assistantMessageId: string | null = null;
  let perSentenceFires = 0;
  let postStreamSupervisorFires = 0;
  let streamedAttempts = 0;

  // §9.6 streaming tool-use — stream one model turn to the client with the
  // per-sentence supervisor applied. Returns the assembled message so the
  // caller can run the tool-use loop, or signals an early abort (per-sentence
  // hit → regen) or vendor error (→ fall back). Shared by the initial turn
  // and the post-tool follow-up so neither duplicates the stream plumbing.
  type StreamedTurn =
    | { kind: "ok"; text: string; raw: AnthropicMessage }
    | { kind: "abort"; hashedTerm: string | undefined }
    | { kind: "error" };

  const streamTurn = async (
    sys: string,
    messages: TurnMessage[],
  ): Promise<StreamedTurn> => {
    const abortController = new AbortController();
    const { textStream, done } = instrumentedClaudeStream({
      tenant_id: tenantId,
      conversation_id: conversationId,
      user_id: userId,
      model: generationModel,
      purpose: chatPurpose,
      max_tokens: 1024,
      system: sys,
      messages,
      tools: tools as unknown as AnthropicTool[],
      signal: abortController.signal,
    });

    try {
      for await (const sentence of bufferToSentences(textStream)) {
        const check = checkSentence(sentence, slurDenyList);
        if (check.hit) {
          abortController.abort();
          // Drain the wrapper's logging path (it rejects `done` on abort).
          try { await done; } catch { /* expected on abort */ }
          return { kind: "abort", hashedTerm: check.hashedTerm };
        }
        // Append a trailing space — bufferToSentences strips inter-sentence
        // whitespace, and the client concatenates deltas verbatim.
        await send({ type: "delta", text: sentence + " " });
      }
    } catch {
      // Vendor failure was already recorded inside the wrapper.
      return { kind: "error" };
    }

    try {
      const finalResult = await done;
      return { kind: "ok", text: finalResult.text, raw: finalResult.raw };
    } catch {
      // Stream looked clean but final-message resolution failed (network blip
      // after last chunk). Fall back rather than recover from partial state.
      return { kind: "error" };
    }
  };

  for (let attempt = 0; attempt < REGEN_HARD_CEILING; attempt++) {
    const sys = extraInstruction ? `${systemPrompt}\n\n${extraInstruction}` : systemPrompt;

    let candidateText = "";

    if (streamingEnabled) {
      streamedAttempts++;
      // ── BP24 streaming branch — option B UX ──
      // Stream sentences directly to the client. On a per-sentence flag, abort
      // + regen. §9.6: if the streamed turn emits tool_use blocks, dispatch
      // them and stream the follow-up reply (single pass, mirroring the non-
      // streaming branch). The pre-tool preamble already shown is cleared via
      // `rewriting` so only the post-tool reply is surfaced — matching the
      // non-streaming branch, where candidate = the follow-up text.
      let turnMessages: TurnMessage[] = chatHistory;
      let toolPass = 0;
      let dispatched: Awaited<ReturnType<typeof runToolUseLoop>> = null;
      let vendorDown = false;
      let regen = false;

      for (;;) {
        if (toolPass === 0) {
          await send({ type: "delta_start" });
        } else {
          // Clear the pre-tool preamble on screen, then open a fresh bubble
          // for the post-tool reply (same sequence the regen path uses).
          await send({ type: "rewriting" });
          await send({ type: "delta_start" });
        }

        const turn = await streamTurn(sys, turnMessages);
        if (turn.kind === "error") {
          vendorDown = true;
          break;
        }
        if (turn.kind === "abort") {
          perSentenceFires++;
          console.warn("[chat-stream] per-sentence supervisor hit", {
            conversation_id: conversationId,
            attempt,
            tool_pass: toolPass,
            hashed_term: turn.hashedTerm,
          });
          regen = true;
          break;
        }

        // Clean turn. Single-pass tool-use: only the first turn may dispatch
        // (a follow-up's own tool_use, if any, is left for a later turn — the
        // same single-pass contract as the non-streaming branch).
        if (toolPass === 0) {
          const loopOut = await runToolUseLoop({
            result: { raw: turn.raw },
            originalMessages: chatHistory,
            dispatchCtx: {
              ctx,
              db: svc,
              conversation_id: conversationId,
              contact_id: conversationContactId,
              customer_email: customerEmail,
              persona_slug: personaSlug,
            },
          });
          if (loopOut) {
            dispatched = loopOut;
            turnMessages = loopOut.followUpMessages;
            toolPass++;
            continue; // stream the post-tool reply
          }
        }

        candidateText = turn.text;
        break;
      }

      if (vendorDown) {
        await send({
          type: "delta",
          text: "Our AI is temporarily unavailable. Please leave a message and we'll be in touch.",
        });
        await send({ type: "supervisor", action: "allow", regens: attempt });
        await send({ type: "done" });
        await close();
        return { status: "aborted" };
      }
      if (regen) {
        await send({ type: "rewriting" });
        extraInstruction = HATE_SPEECH_REGEN_INSTRUCTION;
        continue;
      }
      if (dispatched) {
        console.info(
          `[chat:tool-use:stream] dispatched=${dispatched.dispatchedTools.join(",")} mutated=${dispatched.mutated}`,
        );
      }
    } else {
      // ── Non-streaming branch ──
      // §9.6 tool-use loop: pass the audience/tier-selected tools; if the response includes
      // tool_use blocks, dispatch them and make a follow-up call with
      // tool_result blocks attached. The streaming branch above runs the
      // same single-pass loop (#421). Single-pass: if the follow-up itself
      // triggers another tool_use, that's the supervisor / regen's problem.
      try {
        // instrumentedClaudeCall records vendor health + ai_call_log +
        // tenant_usage_metrics increment + state-transition check.
        const baseArgs = {
          tenant_id: tenantId,
          conversation_id: conversationId,
          user_id: userId,
          model: generationModel,
          purpose: chatPurpose,
          max_tokens: 1024,
          system: sys,
        };
        let result = await instrumentedClaudeCall({
          ...baseArgs,
          messages: chatHistory,
          tools: tools as unknown as AnthropicTool[],
        });

        // Tool-use loop. Returns null if no tool_use blocks — common case.
        const loopOut = await runToolUseLoop({
          result,
          originalMessages: chatHistory,
          dispatchCtx: {
            ctx,
            db: svc,
            conversation_id: conversationId,
            contact_id: conversationContactId,
            customer_email: customerEmail,
            persona_slug: personaSlug,
          },
        });
        if (loopOut) {
          // Follow-up call with tool_result blocks appended.
          result = await instrumentedClaudeCall({
            ...baseArgs,
            messages: loopOut.followUpMessages,
            tools: tools as unknown as AnthropicTool[],
          });
          console.info(
            `[chat:tool-use] dispatched=${loopOut.dispatchedTools.join(",")} mutated=${loopOut.mutated}`,
          );
        }
        candidateText = result.text;
      } catch {
        // Vendor failure was already recorded inside the wrapper.
        await send({
          type: "delta",
          text: "Our AI is temporarily unavailable. Please leave a message and we'll be in touch.",
        });
        await send({ type: "supervisor", action: "allow", regens: attempt });
        await send({ type: "done" });
        await close();
        return { status: "aborted" };
      }
    }

    candidate = candidateText;

    // Insert/UPDATE assistant message row so supervisor has a message_id to write findings to.
    if (!assistantMessageId) {
      const { data: ins, error: insErr } = await svc
        .from("messages")
        .insert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          role: "assistant",
          content: candidate,
          rag_chunks_used: retrieval.retrieved_chunk_ids.length > 0
            ? { ids: retrieval.retrieved_chunk_ids, citations: retrieval.citations }
            : null,
        })
        .select("id")
        .single();
      // Surface the discarded write error (D-091, #400). The null-guard below
      // still drives the user-facing message_persist_failed path; this logs
      // the root cause so a persist failure isn't invisible in production.
      if (insErr) console.error(`[chat] assistant message insert failed: ${insErr.message}`);
      assistantMessageId = (ins as { id?: string } | null)?.id ?? null;
    } else {
      await safeAwait(svc
        .from("messages")
        .update({ content: candidate })
        .eq("id", assistantMessageId)
        .eq("tenant_id", tenantId), "messages.update");
    }
    if (!assistantMessageId) {
      await send({ type: "error", message: "message_persist_failed" });
      await close();
      return { status: "aborted" };
    }

    supervisorOutcome = await runSupervisor({
      ctx,
      conversation_id: conversationId,
      message_id: assistantMessageId,
      candidate_response: candidate,
      retrieved_chunks: retrieval.retrieved_chunk_ids,
      db: svc,
      entities: { intent: retrieval.entities.intent, categories_hint: retrieval.entities.categories_hint },
      tenant_tone_max_level: tenantMaxTone,
      tenant_allow_profanity: tenantAllowProfanity,
      customer_prior_message: userMessage,
    });

    if (supervisorOutcome.action === "allow") break;
    if (supervisorOutcome.action === "escalate") break;

    // regenerate — in streaming mode the bad draft is already on the user's
    // screen, so tell the client to clear it before the next attempt streams.
    if (streamingEnabled) {
      postStreamSupervisorFires++;
      await send({ type: "rewriting" });
    }
    const hitLexical = supervisorOutcome.findings.some(
      (f) => f.check === "tone_drift" && f.details.startsWith("lexical_match:"),
    );
    extraInstruction = hitLexical
      ? HATE_SPEECH_REGEN_INSTRUCTION
      : "Your previous response was flagged for tone or grounding. Rewrite with stricter adherence to the rules in the system prompt.";
  }

  if (!assistantMessageId || !supervisorOutcome) {
    // Pathological exit: every attempt aborted before persisting (six
    // consecutive per-sentence fires). No message row exists and no supervisor
    // ran — fail loud instead of delivering an empty turn (the pre-extraction
    // code returned null behind a `!` and silently no-op'd downstream).
    await send({ type: "error", message: "message_persist_failed" });
    await close();
    return { status: "aborted" };
  }

  return {
    status: "complete",
    candidate,
    supervisorOutcome,
    assistantMessageId,
    streamedAttempts,
    perSentenceFires,
    postStreamSupervisorFires,
  };
}
