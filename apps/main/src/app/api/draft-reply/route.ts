// #904 / D-193 Phase 3 — generate a customer-reply draft in the TA's voice.
//
// DRAFT-ONLY BY CONTRACT (D-193 decision 1): this route returns text; it
// imports no email module and there is no send path. The TA copies the
// draft into their own mail client. A test pins the no-send invariant.
//
// Pipeline: assertPermission(draft_reply:create — agent/owner only)
//   → daily cap (ai_call_log count, fail-closed)
//   → RAG retrieval on the inquiry (tenant-scoped; conversation_id null —
//     drafts persist no conversation row)
//   → buildSystemPrompt(audience='tenant_member') + VOICE PROFILE block
//     (resolveVoiceProfile: own → house → null) + DRAFT TASK block
//   → instrumentedClaudeCall purpose='draft_reply' → JSON { draft }.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";
import { retrieveForChat } from "@/lib/rag/retrieve-for-chat";
import { resolveVoiceProfile } from "@/lib/voice-profiles/resolve-voice-profile";
import { enforceDraftReplyLimit } from "@/lib/draft/draft-reply-limit";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const DRAFT_MODEL = process.env.CHAT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "draft_reply",
      action: "create",
    });

    let body: {
      inquiry?: string;
      customer_name?: string | null;
      persona_slug?: string;
      subject?: string | null;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const inquiry = (body.inquiry ?? "").trim();
    if (!inquiry) return Response.json({ error: "empty_inquiry" }, { status: 400 });
    if (inquiry.length > 8000) {
      return Response.json({ error: "inquiry_too_long" }, { status: 400 });
    }
    const personaSlug = (body.persona_slug ?? "").trim();
    if (!personaSlug) return Response.json({ error: "missing_persona_slug" }, { status: 400 });
    const customerName = (body.customer_name ?? "").trim() || null;

    const db = tenantClient(ctx);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    const { data: urow, error: uErr } = await db
      .from("users")
      .select("id")
      .eq("auth_user_id", authUserId ?? "")
      .eq("status", "active")
      .maybeSingle();
    if (uErr) return dbErrorResponse(uErr);
    const publicUserId = (urow as { id: string } | null)?.id ?? null;
    if (!publicUserId) return Response.json({ error: "member_not_found" }, { status: 403 });

    const limit = await enforceDraftReplyLimit(db, {
      tenant_id: ctx.tenant_id,
      user_id: publicUserId,
    });
    if (!limit.allowed) {
      const msg = limit.reason === "cap"
        ? `Daily draft limit reached (${limit.cap}). It resets at midnight UTC.`
        : "Drafting is temporarily unavailable. Please try again in a few minutes.";
      return Response.json({ error: msg }, { status: 429 });
    }

    // Tenant tier (same lookup as the chat route) — buildSystemPrompt input.
    const { data: tenantRow } = await db
      .from("tenants").select("tier_id").eq("id", ctx.tenant_id).maybeSingle();
    let tenantTier = "byo_research";
    const tierId = (tenantRow as { tier_id?: string } | null)?.tier_id;
    if (tierId) {
      const { data: tierRow } = await db
        .from("tier_definitions").select("code").eq("id", tierId).maybeSingle();
      tenantTier = (tierRow as { code?: string } | null)?.code ?? "byo_research";
    }

    // Travel-domain grounding. customer_has_booking=true: staff see their own
    // tenant's promos (same reasoning as TA chat, D-195).
    const retrieval = await retrieveForChat({
      message: inquiry,
      tenant_id: ctx.tenant_id,
      user_id: publicUserId,
      conversation_id: null,
      persona_id: personaSlug,
      customer_has_booking: true,
    });

    const voice = await resolveVoiceProfile(db, publicUserId);

    const { prompt: systemBase } = await buildSystemPrompt({
      persona_slug: personaSlug,
      tenant_id: ctx.tenant_id,
      tenant_tier: tenantTier,
      tone_level: 2,
      db,
      audience: "tenant_member",
      knowledge_block: retrieval.knowledge_block,
    });

    const voiceBlock = voice
      ? `THE AGENT'S WRITING VOICE (write the reply in THIS voice, not your persona's):\n${
          voice.card_override
            ? voice.card_override
            : JSON.stringify(voice.style_card, null, 2)
        }`
      : `THE AGENT'S WRITING VOICE: no voice profile is configured — use a neutral, warm professional email register.`;

    const greetingInstruction = customerName
      ? `Greet the customer by first name: "${customerName}".`
      : `The customer's name is unknown — open the email with the literal placeholder [name] (e.g. "Hi [name],") so the agent can fill it in. Do NOT invent a name.`;

    const taskBlock = [
      "DRAFT TASK:",
      "You are ghost-writing an email reply FROM the travel agent TO their customer, answering the inquiry below.",
      greetingInstruction,
      "Follow the agent's greeting and sign-off conventions from the voice block. Sign as the agent (or leave their sign-off as the voice block specifies) — never as an AI or as your persona.",
      "Use ONLY facts from the KNOWLEDGE CONTEXT for itineraries, ships, dates, and prices; where it has nothing, ask a clarifying question or say you'll confirm rather than inventing details.",
      "Output ONLY the email body — no subject line, no commentary.",
      body.subject ? `The customer's subject line was: ${String(body.subject).slice(0, 200)}` : "",
      "",
      "CUSTOMER INQUIRY:",
      inquiry,
    ].filter(Boolean).join("\n");

    const result = await instrumentedClaudeCall({
      tenant_id: ctx.tenant_id,
      user_id: publicUserId,
      model: DRAFT_MODEL,
      purpose: "draft_reply",
      max_tokens: 1024,
      system: `${systemBase}\n\n${voiceBlock}`,
      messages: [{ role: "user", content: taskBlock }],
    });

    return Response.json({
      draft: result.text,
      voice_profile_missing: voice === null,
      citations: retrieval.citations,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
