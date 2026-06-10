/**
 * BP31 §32.6.2 / §32.4 — Help AI chat message endpoint.
 *
 * POST returns a text/event-stream of `data: <chunk>\n\n` frames followed
 * by `data: [DONE]\n\n`. The HelpAIPanel client decodes the stream and
 * appends chunks to the latest assistant message in real time.
 *
 * Pipeline:
 *   1. assertPermission + load help_sessions row (RLS scoped).
 *   2. §10.6 kill-switch check: if `platform_settings.ai_kill_switch_engaged`
 *      is true, return the standard fallback message and exit.
 *   3. For bug/feature flows: advance the flow state machine + persist
 *      the working draft. The next question becomes part of the prompt.
 *   4. Build the Help AI system prompt via `buildSystemPrompt(persona_slug='help_ai')`.
 *      Tenant addendums are skipped (§32.4.1 — handled by the prompt
 *      builder's kind='platform_help' bypass).
 *   5. Call `instrumentedClaudeCall` with `purpose='help_ai_main'` — this
 *      records vendor health + ai_call_log + tenant_usage_metrics.
 *   6. Stream the response back via SSE. (The Anthropic SDK call is
 *      non-streaming inside the wrapper; we chunk the final text into
 *      ~30-token frames for the UX of progressive disclosure. Real
 *      token streaming is a follow-on — the wrapper would need a
 *      streaming variant.)
 *
 * For Phase C the supervisor preflight is minimal: just the kill switch.
 * The full hallucination check + tone drift wires in a follow-on when
 * the supervisor's check-suite is exposed for non-customer chat.
 */

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";
import { buildHelpContextBlock } from "@/lib/chat/help-context";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { instrumentedClaudeStream } from "@/lib/ai/stream-wrapper";
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import { bufferToSentences } from "@/lib/ai/sentence-buffer";
import { loadUnionSlurDenyList } from "@/lib/supervisor/load-deny-list";
import { checkSentence } from "@/lib/supervisor/per-sentence-check";
import { env } from "@/lib/env";
import { safeAwait } from "@/lib/db/safe-mutation";
// D-097 — help-AI turns now count toward customer chat metrics. Mirrors
// the customer-chat route's counter increment pattern (D-091 R3 #56).
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementChatMessages } from "@/lib/abuse/counters";
import { respondToAuthError } from "@/lib/auth/respond";
import {
  advanceBugFlow,
  advanceFeatureFlow,
  bugStepFor,
  featureStepFor,
  EMPTY_BUG_DRAFT,
  EMPTY_FEATURE_DRAFT,
  BUG_FLOW_STEPS,
  FEATURE_FLOW_STEPS,
  type BugDraft,
  type BugFlowState,
  type FeatureDraft,
  type FeatureFlowState,
} from "@/lib/help-ai/flow-controller";

const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function sseLine(text: string): string {
  return `data: ${text}\n\n`;
}

const KILL_SWITCH_MESSAGE =
  "Our AI is paused right now. Please leave a message and we'll be in touch.";

// BP24 option B UX — sentinel value the HelpAIPanel client recognises to
// clear the in-flight assistant bubble. Sent before a fallback message when
// the per-sentence supervisor aborts a streamed draft. Unlike the chat
// route, help-AI has no regen loop, so a per-sentence hit is terminal and
// the fallback is the user's final answer for this turn.
const REWRITE_SENTINEL = "[REWRITE]";

const PER_SENTENCE_FALLBACK_MESSAGE =
  "Sorry — that response didn't come out right. Please rephrase or try again.";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  let ctx: Awaited<ReturnType<typeof assertPermission>>["ctx"];
  let user: Awaited<ReturnType<typeof assertPermission>>["user"];
  let userText: string;
  try {
    const auth = await assertPermission(req, { resource: "help_session", action: "update" });
    ctx = auth.ctx;
    user = auth.user;
    const body = (await req.json().catch(() => ({}))) as { message?: string };
    userText = (body.message ?? "").trim();
    if (!userText) {
      return Response.json({ error: "empty_message" }, { status: 400 });
    }
  } catch (err) {
    return respondToAuthError(err);
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const sessionId = params.id;
  const userMessage = userText;

  // allow-void-async: SSE handler — work feeds the TransformStream whose readable is
  // returned in the Response below, so it must run after the Response returns. Errors
  // are written into the stream; the durable message insert happens inside.
  void (async () => {
    try {
      const db = tenantClient(ctx);

      // Load the session — RLS confirms it belongs to ctx.tenant_id.
      const { data: sessionRow } = await db
        .from("help_sessions")
        .select("id, session_type, conversation_id")
        .eq("id", sessionId)
        .maybeSingle();
      const session = sessionRow as { id: string; session_type: "help" | "bug" | "feature"; conversation_id: string | null } | null;
      if (!session) {
        await writer.write(encoder.encode(sseLine("Session not found.")));
        await writer.write(encoder.encode(sseLine("[DONE]")));
        await writer.close();
        return;
      }

      // §10.6 kill-switch — if global AI is paused, return the standard
      // fallback without ever calling Anthropic.
      const { data: killRow } = await db
        .from("platform_settings")
        .select("value")
        .eq("key", "ai_kill_switch_engaged")
        .maybeSingle();
      const killValue = (killRow as { value?: unknown } | null)?.value;
      const killEngaged = killValue === true || killValue === "true";
      if (killEngaged) {
        await writer.write(encoder.encode(sseLine(KILL_SWITCH_MESSAGE)));
        await writer.write(encoder.encode(sseLine("[DONE]")));
        await writer.close();
        return;
      }

      // §10.6 per-tenant kill switch (same as the customer chat route).
      // Read tenants.ai_paused_by_platform; if true return the §10.6 fallback
      // without calling Anthropic. Same fallback message as the global one
      // because the customer experience is the same either way.
      const { data: tenantKillRow } = await db
        .from("tenants")
        .select("ai_paused_by_platform")
        .eq("id", ctx.tenant_id)
        .maybeSingle();
      const tenantPaused = Boolean(
        (tenantKillRow as { ai_paused_by_platform?: boolean } | null)?.ai_paused_by_platform,
      );
      if (tenantPaused) {
        await writer.write(encoder.encode(sseLine(KILL_SWITCH_MESSAGE)));
        await writer.write(encoder.encode(sseLine("[DONE]")));
        await writer.close();
        return;
      }

      // D-097 — help-AI persistence. Help sessions now write their own
      // user + assistant turns to `messages`, so within-help-AI multi-turn
      // context actually works (was deferred from D-095). For admin-source
      // sessions where session.conversation_id is NULL, create the
      // conversation row on first message and bind it to the help session.
      let conversationId = session.conversation_id;
      if (!conversationId) {
        // §15.12 sandbox: stamp is_test on the conversation row at creation time
        // (snapshot semantics, same as the customer chat route).
        //
        // Fail CLOSED on read error: default isTest=true when we can't confirm
        // the tenant's sandbox state. Same reasoning as the chat route — the
        // audit firewall must not be silently leaked to.
        const { data: sandboxRow, error: sandboxErr } = await db
          .from("tenants")
          .select("is_sandbox")
          .eq("id", ctx.tenant_id)
          .maybeSingle();
        const isTest = sandboxErr
          ? true
          : Boolean((sandboxRow as { is_sandbox?: boolean } | null)?.is_sandbox);

        const { data: createdConv, error: convErr } = await db
          .from("conversations")
          .insert({
            tenant_id: ctx.tenant_id,
            user_id: user.id,
            status: "active",
            first_message_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            message_count: 0,
            is_test: isTest,
          })
          .select("id")
          .single();
        if (convErr || !createdConv) {
          await writer.write(encoder.encode(sseLine(
            `Error: help_conversation_create_failed: ${convErr?.message ?? "unknown"}`,
          )));
          await writer.write(encoder.encode(sseLine("[DONE]")));
          await writer.close();
          return;
        }
        conversationId = (createdConv as { id: string }).id;
        await safeAwait(
          db.from("help_sessions")
            .update({ conversation_id: conversationId })
            .eq("id", sessionId),
          "help_sessions.update.bind_conversation",
        );
      }

      // D-095 — Load the conversation history ONCE. Used for both:
      //   (a) Flow-state reconstruction (bug/feature): we want user turns
      //       in chronological order so we can count them and replay
      //       answers into the draft.
      //   (b) LLM context (below): full user+assistant turns prepended
      //       to the current message.
      // Earlier the route issued two separate queries against `messages`
      // for the same conversation_id (loadPriorUserMessages and
      // loadConversationHistory). Greptile P2 noted that the user-only
      // subset can be derived from the full history in memory.
      const fullHistory = await loadConversationHistory(db, ctx.tenant_id, conversationId);

      // D-097 — persist the customer's current user message BEFORE the
      // LLM call so any subsequent help-AI turn loading history sees this
      // turn. Mirrors the customer-chat route's pattern.
      await safeAwait(
        db.from("messages").insert({
          tenant_id: ctx.tenant_id,
          conversation_id: conversationId,
          role: "user",
          content: userMessage,
        }),
        "messages.insert.help_ai_user_turn",
      );
      const priorUserMessages = fullHistory
        .filter((t) => t.role === "user")
        .map((t) => t.content);

      // For bug/feature flows we derive the current state by counting prior
      // user messages in this session's conversation — the bot asks each
      // step's question exactly once, so the count is the position in
      // BUG_FLOW_STEPS / FEATURE_FLOW_STEPS. We then rebuild the working
      // draft from those same prior messages so the summary at the end can
      // recite back the user's own answers verbatim.
      let nextQuestion = "";
      let draftSnapshot: BugDraft | FeatureDraft | null = null;

      if (session.session_type === "bug") {
        const currentState = bugStateForIndex(priorUserMessages.length);
        const reconstructed = reconstructBugDraft(priorUserMessages);
        const advanced = advanceBugFlow(currentState, reconstructed, userMessage);
        draftSnapshot = advanced.draft;
        const step = bugStepFor(advanced.state);
        nextQuestion = step?.question ?? "Thanks — that's everything I need. I'll summarize before submitting.";
      } else if (session.session_type === "feature") {
        const currentState = featureStateForIndex(priorUserMessages.length);
        const reconstructed = reconstructFeatureDraft(priorUserMessages);
        const advanced = advanceFeatureFlow(currentState, reconstructed, userMessage);
        draftSnapshot = advanced.draft;
        const step = featureStepFor(advanced.state);
        nextQuestion = step?.question ?? "Thanks — that's everything I need. I'll summarize before submitting.";
      }

      // Build the Help AI persona prompt.
      // #906: for open Q&A turns (session_type='help'), inject the
      // PLATFORM HELP CONTEXT block so answers are grounded in the shipped
      // docs rather than model priors. Bug/feature flows have their own
      // structured content and don't need it. Empty tierCode = no tier
      // filter (help_ai serves every plan tier).
      const helpContextBlock =
        session.session_type === "help"
          ? buildHelpContextBlock(userMessage, "")
          : null;

      const { prompt: systemPrompt } = await buildSystemPrompt({
        persona_slug: "help_ai",
        tenant_id: ctx.tenant_id,
        tenant_tier: "sub_pro", // tenant tier is irrelevant for Help AI (no addendum applied)
        db,
        ...(helpContextBlock ? { help_context_block: helpContextBlock } : {}),
      });
      const stateAddendum = nextQuestion
        ? `\n\nThe user is in a structured ${session.session_type} flow. After acknowledging their last message, ask exactly the following next question verbatim: "${nextQuestion}"`
        : "";
      const promptedSystem = systemPrompt + stateAddendum;

      const model = env().ANTHROPIC_SONNET_MODEL;

      // D-095/D-097 — Conversation history for the LLM call. After D-097
      // the current userMessage is already persisted, so re-loading would
      // include it as the last turn. To avoid the extra roundtrip we just
      // append the in-memory userMessage to the pre-persist fullHistory.
      const messagesForLlm: Array<{ role: "user" | "assistant"; content: string }> =
        [...fullHistory, { role: "user", content: userMessage }];

      // BP24 — Help-AI streaming opt-in. Default off; flip
      // HELP_AI_STREAMING_ENABLED=true to use the streaming wrapper +
      // per-sentence deny-list check. The chat route has its own flag
      // (CHAT_STREAMING_ENABLED) so help-AI can roll out independently.
      const streamingEnabled = process.env.HELP_AI_STREAMING_ENABLED === "true";

      let assistantText = "";

      if (streamingEnabled) {
        // Per-sentence deny-list — same source of truth the customer-chat
        // supervisor uses (loaded once per turn).
        const slurDenyList = await loadUnionSlurDenyList(db, ctx.tenant_id);
        const abortController = new AbortController();

        const { textStream, done } = instrumentedClaudeStream({
          tenant_id: ctx.tenant_id,
          model,
          purpose: "help_ai_main",
          max_tokens: 800,
          system: promptedSystem,
          messages: messagesForLlm,
          signal: abortController.signal,
        });

        let aborted = false;
        let perSentenceHashedTerm: string | undefined;

        try {
          for await (const sentence of bufferToSentences(textStream)) {
            const check = checkSentence(sentence, slurDenyList);
            if (check.hit) {
              abortController.abort();
              aborted = true;
              perSentenceHashedTerm = check.hashedTerm;
              break;
            }
            // Stream each clean sentence (with a trailing space — the buffer
            // strips inter-sentence whitespace).
            await writer.write(encoder.encode(sseLine(sentence + " ")));
            assistantText += sentence + " ";
          }
        } catch (streamErr) {
          console.warn("[help-ai-stream] stream error before completion", {
            session_id: sessionId,
            tenant_id: ctx.tenant_id,
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
          });
          await writer.write(encoder.encode(sseLine("Our AI is temporarily unavailable. Please try again in a moment.")));
          await writer.write(encoder.encode(sseLine("[DONE]")));
          await writer.close();
          return;
        }

        if (aborted) {
          // Let the wrapper finish its cost-accounting path (rejects on abort).
          try { await done; } catch { /* expected */ }
          console.warn("[help-ai-stream] per-sentence supervisor hit", {
            session_id: sessionId,
            tenant_id: ctx.tenant_id,
            hashed_term: perSentenceHashedTerm,
          });
          // Tell the client to clear what's on screen, then deliver the
          // fallback. Help-AI has no regen loop — the fallback is final.
          await writer.write(encoder.encode(sseLine(REWRITE_SENTINEL)));
          await writer.write(encoder.encode(sseLine(PER_SENTENCE_FALLBACK_MESSAGE)));
          await writer.write(encoder.encode(sseLine("[DONE]")));
          await writer.close();
          // Skip the help_sessions update — this turn didn't produce a valid
          // assistant message.
          return;
        }

        // Clean stream complete — trust the wrapper's done promise for the
        // canonical text (cost accounting parity with the non-streaming branch).
        try {
          const finalResult = await done;
          assistantText = finalResult.text;
        } catch (doneErr) {
          console.warn("[help-ai-stream] done promise rejected", {
            session_id: sessionId,
            tenant_id: ctx.tenant_id,
            error: doneErr instanceof Error ? doneErr.message : String(doneErr),
          });
          await writer.write(encoder.encode(sseLine("Our AI is temporarily unavailable. Please try again in a moment.")));
          await writer.write(encoder.encode(sseLine("[DONE]")));
          await writer.close();
          return;
        }

        await writer.write(encoder.encode(sseLine("[DONE]")));
        await writer.close();
      } else {
        // ── Non-streaming branch — original behaviour, unchanged ──
        try {
          const result = await instrumentedClaudeCall({
            tenant_id: ctx.tenant_id,
            model,
            purpose: "help_ai_main",
            max_tokens: 800,
            system: promptedSystem,
            messages: messagesForLlm,
          });
          assistantText = result.text;
        } catch {
          await writer.write(encoder.encode(sseLine("Our AI is temporarily unavailable. Please try again in a moment.")));
          await writer.write(encoder.encode(sseLine("[DONE]")));
          await writer.close();
          return;
        }

        // Chunk the final text into ~80-char frames so the UI shows
        // progressive rendering.
        const CHUNK = 80;
        for (let i = 0; i < assistantText.length; i += CHUNK) {
          await writer.write(encoder.encode(sseLine(assistantText.slice(i, i + CHUNK))));
        }
        await writer.write(encoder.encode(sseLine("[DONE]")));
        await writer.close();
      }

      // D-097 — persist the assistant turn so the next help-AI message
      // in this session sees this exchange. Skipped on the per-sentence
      // abort path (handled inline above with early-return).
      if (assistantText) {
        await safeAwait(
          db.from("messages").insert({
            tenant_id: ctx.tenant_id,
            conversation_id: conversationId,
            role: "assistant",
            content: assistantText,
          }),
          "messages.insert.help_ai_assistant_turn",
        );
      }

      // D-096 — help-AI turns now count toward customer chat metrics.
      // Same incrementChatMessages call the customer-chat route uses, so
      // help-AI usage burns into the tenant's chat quota / cost ledger.
      // Non-fatal: the message rows already persisted; we don't want to
      // surface a 500 over usage attribution failure.
      try {
        const svc = createServiceRoleClient();
        const snapshot = await loadTenantSnapshot(svc, ctx.tenant_id);
        await incrementChatMessages({ db: svc, tenant: snapshot.tenant });
      } catch (err) {
        console.warn(
          `[help-ai] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Bump the session's ai_messages_count + record the draft snapshot
      // out-of-band. RLS-scoped update.
      await safeAwait(db
        .from("help_sessions")
        .update({ ai_messages_count: 1 })
        .eq("id", sessionId), "help_sessions.update");
      void draftSnapshot; // v1 doesn't persist the per-message draft.
    } catch (err) {
      try {
        await writer.write(encoder.encode(sseLine(`Error: ${err instanceof Error ? err.message : "internal_error"}`)));
        await writer.write(encoder.encode(sseLine("[DONE]")));
      } finally {
        await writer.close();
      }
    }
  })();

  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

function bugStateForIndex(priorUserMessageCount: number): BugFlowState {
  const step = BUG_FLOW_STEPS[Math.min(priorUserMessageCount, BUG_FLOW_STEPS.length - 1)];
  return step ? step.state : "submitted";
}

function featureStateForIndex(priorUserMessageCount: number): FeatureFlowState {
  const step = FEATURE_FLOW_STEPS[Math.min(priorUserMessageCount, FEATURE_FLOW_STEPS.length - 1)];
  return step ? step.state : "submitted";
}

function reconstructBugDraft(priorUserMessages: string[]): BugDraft {
  let draft: BugDraft = { ...EMPTY_BUG_DRAFT };
  let state: BugFlowState = "gathering_location";
  for (const msg of priorUserMessages) {
    const advanced = advanceBugFlow(state, draft, msg);
    state = advanced.state;
    draft = advanced.draft;
  }
  return draft;
}

function reconstructFeatureDraft(priorUserMessages: string[]): FeatureDraft {
  let draft: FeatureDraft = { ...EMPTY_FEATURE_DRAFT };
  let state: FeatureFlowState = "gathering_what";
  for (const msg of priorUserMessages) {
    const advanced = advanceFeatureFlow(state, draft, msg);
    state = advanced.state;
    draft = advanced.draft;
  }
  return draft;
}
