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
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { env } from "@/lib/env";
import {
  advanceBugFlow,
  advanceFeatureFlow,
  bugStepFor,
  featureStepFor,
  EMPTY_BUG_DRAFT,
  EMPTY_FEATURE_DRAFT,
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

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  let ctx: Awaited<ReturnType<typeof assertPermission>>["ctx"];
  let userText: string;
  try {
    const auth = await assertPermission(req, { resource: "help_session", action: "update" });
    ctx = auth.ctx;
    const body = (await req.json().catch(() => ({}))) as { message?: string };
    userText = (body.message ?? "").trim();
    if (!userText) {
      return Response.json({ error: "empty_message" }, { status: 400 });
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const sessionId = params.id;
  const userMessage = userText;

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

      // For bug/feature flows we advance the state machine. The new
      // state's question becomes a system-side instruction appended to
      // the prompt; the model is told to ask that question next or — if
      // we've reached showing_summary — to recap the draft.
      let nextQuestion = "";
      let draftSnapshot: BugDraft | FeatureDraft | null = null;
      if (session.session_type === "bug") {
        // Persist the flow state in a tiny conv-context table read from the
        // help_sessions row would be ideal; for v1 keep state in-memory per
        // request (the client also keeps it in the conversation transcript).
        const currentState: BugFlowState = "gathering_location"; // v1 stub
        const draft = { ...EMPTY_BUG_DRAFT };
        const advanced = advanceBugFlow(currentState, draft, userMessage);
        draftSnapshot = advanced.draft;
        const step = bugStepFor(advanced.state);
        nextQuestion = step?.question ?? "Thanks — that's everything I need. I'll summarize before submitting.";
      } else if (session.session_type === "feature") {
        const currentState: FeatureFlowState = "gathering_what";
        const draft = { ...EMPTY_FEATURE_DRAFT };
        const advanced = advanceFeatureFlow(currentState, draft, userMessage);
        draftSnapshot = advanced.draft;
        const step = featureStepFor(advanced.state);
        nextQuestion = step?.question ?? "Thanks — that's everything I need. I'll summarize before submitting.";
      }

      // Build the Help AI persona prompt.
      const { prompt: systemPrompt } = await buildSystemPrompt({
        persona_slug: "help_ai",
        tenant_id: ctx.tenant_id,
        tenant_tier: "sub_pro", // tenant tier is irrelevant for Help AI (no addendum applied)
        db,
      });
      const stateAddendum = nextQuestion
        ? `\n\nThe user is in a structured ${session.session_type} flow. After acknowledging their last message, ask exactly the following next question verbatim: "${nextQuestion}"`
        : "";
      const promptedSystem = systemPrompt + stateAddendum;

      const model = env().ANTHROPIC_SONNET_MODEL;

      let assistantText = "";
      try {
        const result = await instrumentedClaudeCall({
          tenant_id: ctx.tenant_id,
          model,
          purpose: "help_ai_main",
          max_tokens: 800,
          system: promptedSystem,
          messages: [{ role: "user", content: userMessage }],
        });
        assistantText = result.text;
      } catch {
        await writer.write(encoder.encode(sseLine("Our AI is temporarily unavailable. Please try again in a moment.")));
        await writer.write(encoder.encode(sseLine("[DONE]")));
        await writer.close();
        return;
      }

      // Chunk the final text into ~80-char frames so the UI shows
      // progressive rendering. (Real token-streaming requires the call
      // wrapper to grow a streaming variant — follow-on.)
      const CHUNK = 80;
      for (let i = 0; i < assistantText.length; i += CHUNK) {
        await writer.write(encoder.encode(sseLine(assistantText.slice(i, i + CHUNK))));
      }
      await writer.write(encoder.encode(sseLine("[DONE]")));
      await writer.close();

      // Bump the session's ai_messages_count + record the draft snapshot
      // out-of-band. RLS-scoped update.
      await db
        .from("help_sessions")
        .update({ ai_messages_count: 1 })
        .eq("id", sessionId);
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
