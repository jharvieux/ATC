// §24 — Chat backend POST handler.
//
// Single entry point for chat traffic — both anonymous (no Authorization)
// and authenticated (Bearer token). Wires:
//
//   1. Resolve tenant (always via x-resolved-tenant-id from middleware) and
//      identify caller (anon session_id cookie OR Supabase user JWT).
//   2. Rate limits:
//        anon  → checkAnonLimit (§24.8 three-identifier) → signup-wall on hit
//        auth  → enforceCustomerLimit (§24.9 three-tier)  → system msg on hard
//   3. Detect customer tone-change request (§24.5) and persist to memory.
//   4. Load / create conversation; persist user message.
//   5. Entity extraction → RAG retrieve.
//   6. Build system prompt (with §24.9 persona augmentation if Soft1/Soft2).
//   7. Anthropic non-streaming call → full candidate response.
//   8. runSupervisor() — may regenerate (loops up to budget) or escalate.
//   9. Persist assistant message with supervisor_findings + rag_chunks_used.
//  10. SSE-stream the approved text word-by-word back to the client.
//
// True Anthropic token-by-token streaming is deferred — the supervisor must
// see the full response BEFORE the customer does (else hate-speech or
// hallucination text leaks). Word-replay satisfies §24.3 streaming UX.
// TODO(bp24-true-stream): explore buffered streaming once supervisor latency
// is acceptable.

import { randomUUID } from "node:crypto";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { tenantContextFromRequest } from "@/lib/db/factories";
import { writeAuditLog } from "@/lib/audit/write";
import { vendorHealthStatus } from "@/lib/vendor-health/registry";
import {
  checkAnonLimit,
  incrementAnonCounters,
  recordLimitHitAndCheckBurst,
} from "@/lib/chat/anonymous-limit";
import {
  enforceCustomerLimit,
  generateHardLimitSummary,
} from "@/lib/chat/customer-limit";
import {
  detectToneOverride,
  applyToneOverride,
} from "@/lib/chat/customer-tone-override";
import { resolveToneLevel } from "@/lib/chat/tone-resolution";
import { deriveFingerprint, extractClientIp } from "@/lib/chat/fingerprint";
import { retrieveForChat } from "@/lib/rag/retrieve-for-chat";
import {
  buildSystemPrompt,
  DEFAULT_PERSONA_SLUG,
} from "@/lib/personas/build-system-prompt";
import {
  runSupervisor,
  HATE_SPEECH_REGEN_INSTRUCTION,
} from "@/lib/supervisor/run-supervisor";
import type { SupervisorOutcome } from "@/lib/supervisor/types";
import type { TenantContext } from "@/lib/db/tenant-context";

const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

const ANON_SESSION_COOKIE = "atc-anon-session";
const REGEN_HARD_CEILING = 6; // safety net; budget is also enforced inside supervisor

// SSE event shape — mirrors what the client consumer expects.
type SseEvent =
  | { type: "delta"; text: string }
  | { type: "message_id"; message_id: string; conversation_id: string }
  | { type: "sources"; citations: unknown[] }
  | { type: "persona"; slug: string; display_name: string }
  | { type: "hard_limit"; body: string; reset_at: string }
  | { type: "signup_wall"; body: string }
  | { type: "escalation"; body: string }
  | { type: "supervisor"; action: "allow" | "regenerate" | "escalate"; regens: number }
  | { type: "done" }
  | { type: "error"; message: string };

function sseEncode(ev: SseEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const [k, ...rest] = pair.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  let body: { message?: string; conversation_id?: string | null; persona_slug?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  const userMessage = (body.message ?? "").toString().trim();
  if (!userMessage) {
    return new Response(JSON.stringify({ error: "empty_message" }), { status: 400 });
  }

  const tenantId = req.headers.get("x-resolved-tenant-id");
  if (!tenantId || tenantId === "platform") {
    return new Response(
      JSON.stringify({ error: "tenant_not_resolved" }),
      { status: 400 },
    );
  }

  const isAuthenticated = req.headers.get("authorization")?.startsWith("Bearer ");

  // ── Build the SSE stream and start the heavy work inline. The TransformStream
  //    lets the route return immediately while we keep writing events.
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const send = async (ev: SseEvent): Promise<void> => {
    await writer.write(encoder.encode(sseEncode(ev)));
  };

  const close = async (): Promise<void> => {
    await writer.close();
  };

  // Run the chat logic asynchronously so the Response can return immediately
  // with the readable stream attached.
  void handleChat({
    req,
    tenantId,
    isAuthenticated: Boolean(isAuthenticated),
    userMessage,
    conversationIdInput: body.conversation_id ?? null,
    personaSlugInput: body.persona_slug ?? null,
    send,
    close,
  }).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await send({ type: "error", message: msg });
    } finally {
      await close();
    }
  });

  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

// ────────────────────────────────────────────────────────────────────────────
// Core chat orchestration
// ────────────────────────────────────────────────────────────────────────────

type HandleChatArgs = {
  req: Request;
  tenantId: string;
  isAuthenticated: boolean;
  userMessage: string;
  conversationIdInput: string | null;
  personaSlugInput: string | null;
  send: (ev: SseEvent) => Promise<void>;
  close: () => Promise<void>;
};

async function handleChat(args: HandleChatArgs): Promise<void> {
  const svc = createServiceRoleClient();
  const { tenantId, isAuthenticated, userMessage, send, close } = args;

  // ── 1. Identify caller (anonymous OR authenticated)
  let ctx: TenantContext | null = null;
  let userId: string | null = null;
  let anonSessionId: string | null = null;

  if (isAuthenticated) {
    try {
      ctx = await tenantContextFromRequest(args.req);
      userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
    } catch (err) {
      await send({ type: "error", message: `auth_failed: ${err instanceof Error ? err.message : String(err)}` });
      await close();
      return;
    }
  } else {
    const cookies = parseCookies(args.req.headers.get("cookie"));
    anonSessionId = cookies[ANON_SESSION_COOKIE] ?? null;
    if (!anonSessionId) {
      anonSessionId = randomUUID();
    }
    // Forge a minimal ctx for downstream helpers that only need tenant_id.
    ctx = { tenant_id: tenantId, source: { kind: "http_request", user_id: anonSessionId } };
  }

  // ── 2. Rate limit
  if (isAuthenticated && userId) {
    const decision = await enforceCustomerLimit(svc, { user_id: userId, tenant_id: tenantId });
    if (decision.tier === "hard") {
      // §24.9 system-spoken hard-limit message — NOT in-character.
      const resetAtPretty = new Date(decision.reset_at).toLocaleDateString();
      const sysBody =
        "Chat limit reached. You've reached the message limit for this billing period. " +
        "To continue chatting, you can book a cruise (which doubles your quota while you have " +
        "an upcoming trip) or request a handoff to a trip consultant. " +
        `Your quota resets ${resetAtPretty}.`;
      await send({ type: "hard_limit", body: sysBody, reset_at: decision.reset_at });

      // Best-effort: generate Haiku summary and write audit + admin alert (stubs).
      const summary = await generateHardLimitSummary(svc, {
        user_id: userId,
        tenant_id: tenantId,
        user_email: null,
      });
      const auditId = randomUUID();
      await writeAuditLog({
        tenant_id: tenantId,
        actor_user_id: userId,
        actor_type: "system",
        action: "customer_chat.hard_limit_blocked",
        resource_type: "user",
        resource_id: userId,
        changes: { audit_correlation_id: auditId, current_count: decision.current_count, summary },
      });
      // Persist the audit id on the counter row so the alert can be re-linked.
      await svc
        .from("customer_chat_counters")
        .update({ hard_limit_summary_audit_id: auditId })
        .eq("user_id", userId)
        .eq("tenant_id", tenantId);

      await send({ type: "done" });
      await close();
      return;
    }
    // Soft1 / Soft2 → persona augmentation feeds the prompt; below tier just proceeds.
    var personaAugmentation: string | null =
      decision.tier === "soft1" || decision.tier === "soft2"
        ? decision.persona_augmentation
        : null;
    var customerCurrentCount: number = decision.current_count;
  } else {
    // Anonymous path
    const ip = extractClientIp(args.req);
    const fingerprint = deriveFingerprint(args.req);
    const limit = await checkAnonLimit(svc, {
      tenant_id: tenantId,
      session_id: anonSessionId!,
      ip,
      fingerprint,
    });
    if (!limit.allowed) {
      await recordLimitHitAndCheckBurst(svc, {
        tenant_id: tenantId,
        session_id: anonSessionId!,
        ip,
        fingerprint,
        hit_identifier_type: limit.hit_identifier_type!,
      });
      // §24.8 — DO NOT reveal which identifier hit.
      await send({
        type: "signup_wall",
        body:
          "You've reached the free chat limit for this session. " +
          "Sign up to keep chatting — it's free and your conversation will be transferred.",
      });
      await send({ type: "done" });
      await close();
      return;
    }
    await incrementAnonCounters(svc, {
      tenant_id: tenantId,
      session_id: anonSessionId!,
      ip,
      fingerprint,
    });
    var personaAugmentation: string | null = null;
    var customerCurrentCount: number = 0;
  }

  // ── 3. Detect customer tone-change (authenticated only — anon has no memory).
  if (isAuthenticated && userId) {
    const override = detectToneOverride(userMessage);
    if (override) {
      // Load tenant max tone to clamp the override.
      const { data: ts } = await svc
        .from("tenant_settings")
        .select("persona_tone_max_level")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      const tenantMax = (ts as { persona_tone_max_level?: number } | null)?.persona_tone_max_level ?? 3;
      await applyToneOverride(svc, {
        tenant_id: tenantId,
        user_id: userId,
        action: override,
        tenant_max_level: tenantMax,
      });
    }
  }

  // ── 4. Load or create conversation; persist user message.
  let conversationId = args.conversationIdInput;
  let conversationActivePersonaId: string | null = null;
  if (conversationId) {
    const { data: conv } = await svc
      .from("conversations")
      .select("id, active_persona_id")
      .eq("id", conversationId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!conv) {
      await send({ type: "error", message: "conversation_not_found" });
      await close();
      return;
    }
    conversationActivePersonaId = (conv as { active_persona_id?: string } | null)?.active_persona_id ?? null;
  } else {
    const { data: created, error: createErr } = await svc
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        anonymous_session_id: !userId ? anonSessionId : null,
        status: "active",
        first_message_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        message_count: 0,
      })
      .select("id")
      .single();
    if (createErr || !created) {
      await send({ type: "error", message: `conversation_create_failed: ${createErr?.message}` });
      await close();
      return;
    }
    conversationId = (created as { id: string }).id;
  }

  // Persist user message.
  await svc.from("messages").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    role: "user",
    content: userMessage,
  });

  // ── 5. Resolve persona, tenant settings, and tone.
  const personaSlug = args.personaSlugInput ?? DEFAULT_PERSONA_SLUG;
  void conversationActivePersonaId;

  const { data: tenantRow } = await svc
    .from("tenants")
    .select("tier_id")
    .eq("id", tenantId)
    .maybeSingle();
  let tenantTier = "byo_research";
  if (tenantRow && (tenantRow as { tier_id?: string }).tier_id) {
    const { data: tierRow } = await svc
      .from("tier_definitions")
      .select("code")
      .eq("id", (tenantRow as { tier_id: string }).tier_id)
      .maybeSingle();
    tenantTier = (tierRow as { code?: string } | null)?.code ?? "byo_research";
  }

  const { data: settings } = await svc
    .from("tenant_settings")
    .select("persona_tone_max_level, allow_profanity")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const tenantMaxTone = (settings as { persona_tone_max_level?: number } | null)?.persona_tone_max_level ?? 3;
  const tenantAllowProfanity = (settings as { allow_profanity?: boolean } | null)?.allow_profanity ?? false;

  let customerRapportLevel: number | null = null;
  let customerRapportDirective: "direct" | null = null;
  if (userId) {
    const { data: mem } = await svc
      .from("customer_memories")
      .select("rapport_tone_level, rapport_tone_directive")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();
    customerRapportLevel = (mem as { rapport_tone_level?: number } | null)?.rapport_tone_level ?? null;
    customerRapportDirective = (mem as { rapport_tone_directive?: "direct" } | null)?.rapport_tone_directive ?? null;
  }

  // ── 6. RAG retrieve.
  const retrieval = await retrieveForChat({
    message: userMessage,
    tenant_id: tenantId,
    user_id: userId ?? anonSessionId ?? "anonymous",
    conversation_id: conversationId,
    persona_id: personaSlug,
    customer_has_booking: false,
  });

  await send({ type: "persona", slug: personaSlug, display_name: personaSlug });
  if (retrieval.citations.length > 0) {
    await send({ type: "sources", citations: retrieval.citations });
  }

  // ── 7. Resolve tone and build system prompt.
  const tone = resolveToneLevel({
    tenant_max_level: tenantMaxTone,
    persona_slug: personaSlug,
    customer_rapport_level: customerRapportLevel,
    customer_rapport_directive: customerRapportDirective,
    customer_message: userMessage,
    ...(retrieval.entities.intent === "support" ? { topic: "cancellation_complaint" as const } : {}),
  });

  const systemPromptBase = await buildSystemPrompt({
    persona_slug: personaSlug,
    tenant_id: tenantId,
    tenant_tier: tenantTier,
    tone_level: tone.level,
    db: svc,
    knowledge_block: retrieval.knowledge_block,
  });

  // Append the §24.9 persona augmentation if Soft1/Soft2 fired.
  let systemPrompt = systemPromptBase.prompt;
  if (personaAugmentation) {
    systemPrompt += `\n\n[Soft-tier note for this turn]\n${personaAugmentation}`;
  }

  // ── 8. Generation + supervisor regen loop.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await send({ type: "error", message: "anthropic_api_key_not_configured" });
    await close();
    return;
  }

  // §26.9 — Anthropic vendor health gate. If the registry says Anthropic is
  // down, surface the §26.9 fallback message directly instead of attempting
  // the call. The probe cron updates the registry every minute; degraded
  // state activates after 3 consecutive failures, down after 5.
  if (vendorHealthStatus("anthropic") === "down") {
    const fallbackBody =
      "Our AI is temporarily unavailable. Please leave a message and we'll be in touch.";
    await send({ type: "delta", text: fallbackBody });
    await send({ type: "supervisor", action: "allow", regens: 0 });
    await send({ type: "done" });
    await close();
    return;
  }

  const generationModel = process.env.CHAT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

  let extraInstruction = "";
  let candidate = "";
  let supervisorOutcome: SupervisorOutcome | null = null;
  let assistantMessageId: string | null = null;

  for (let attempt = 0; attempt < REGEN_HARD_CEILING; attempt++) {
    const sys = extraInstruction ? `${systemPrompt}\n\n${extraInstruction}` : systemPrompt;

    let candidateText: string;
    try {
      // instrumentedClaudeCall records vendor health + ai_call_log +
      // tenant_usage_metrics increment + state-transition check.
      const result = await instrumentedClaudeCall({
        tenant_id: tenantId,
        conversation_id: conversationId,
        user_id: userId,
        model: generationModel,
        purpose: "chat_main",
        max_tokens: 1024,
        system: sys,
        messages: [{ role: "user", content: userMessage }],
      });
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
      return;
    }

    candidate = candidateText;

    // Insert/UPDATE assistant message row so supervisor has a message_id to write findings to.
    if (!assistantMessageId) {
      const { data: ins } = await svc
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
      assistantMessageId = (ins as { id?: string } | null)?.id ?? null;
    } else {
      await svc
        .from("messages")
        .update({ content: candidate })
        .eq("id", assistantMessageId);
    }
    if (!assistantMessageId) {
      await send({ type: "error", message: "message_persist_failed" });
      await close();
      return;
    }

    supervisorOutcome = await runSupervisor({
      ctx: ctx!,
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

    // regenerate
    const hitLexical = supervisorOutcome.findings.some(
      (f) => f.check === "tone_drift" && f.details.startsWith("lexical_match:"),
    );
    extraInstruction = hitLexical
      ? HATE_SPEECH_REGEN_INSTRUCTION
      : "Your previous response was flagged for tone or grounding. Rewrite with stricter adherence to the rules in the system prompt.";
  }

  await send({
    type: "supervisor",
    action: supervisorOutcome?.action ?? "allow",
    regens: supervisorOutcome?.regen_count ?? 0,
  });

  // ── 9. Final delivery.
  if (supervisorOutcome?.action === "escalate") {
    const escalationBody =
      "Thanks for chatting! I'm bringing in someone from the team — they'll be in touch shortly.";
    await send({ type: "escalation", body: escalationBody });
    // Persist the escalation message as a separate row so the transcript reflects it.
    await svc.from("messages").insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      role: "system",
      content: escalationBody,
    });
    await svc
      .from("conversations")
      .update({ status: "escalated", last_message_at: new Date().toISOString() })
      .eq("id", conversationId);
    await send({ type: "message_id", message_id: assistantMessageId!, conversation_id: conversationId });
    await send({ type: "done" });
    await close();
    return;
  }

  // Stream the approved response word-by-word.
  await send({ type: "message_id", message_id: assistantMessageId!, conversation_id: conversationId });
  const words = candidate.split(/(\s+)/);
  for (const w of words) {
    if (!w) continue;
    await send({ type: "delta", text: w });
  }
  await send({ type: "done" });
  await close();

  // Bump conversation last_message_at + count.
  await svc
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      message_count: Math.max(1, customerCurrentCount + 1),
    })
    .eq("id", conversationId);
}
