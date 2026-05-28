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
//   7. Anthropic call: streaming if CHAT_STREAMING_ENABLED=true (BP24,
//      sentence-boundary buffer + per-sentence supervisor — see
//      lib/ai/stream-wrapper.ts and lib/supervisor/per-sentence-check.ts);
//      otherwise non-streaming → full candidate response.
//   8. runSupervisor() — may regenerate (loops up to budget) or escalate.
//      Whole-response checks (grounding, persona drift, asset_id_validation)
//      always run on the assembled text — sentence-level can't see them.
//   9. Persist assistant message with supervisor_findings + rag_chunks_used.
//  10. Streaming mode: deltas already flushed; emit `done`. Non-streaming
//      mode: SSE-stream the approved text word-by-word back to the client.

import { randomUUID } from "node:crypto";
import { redactPii } from "@/lib/pii/redact";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { PERSONA_TOOLS } from "@/lib/personas/tools";
import { runToolUseLoop } from "@/lib/personas/tools/run-tool-use-loop";
import type { AnthropicTool } from "@/lib/ai/call-wrapper";
import { instrumentedClaudeStream } from "@/lib/ai/stream-wrapper";
import { bufferToSentences } from "@/lib/ai/sentence-buffer";
import { loadUnionSlurDenyList } from "@/lib/supervisor/load-deny-list";
import { checkSentence } from "@/lib/supervisor/per-sentence-check";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { tenantContextFromRequest } from "@/lib/db/factories";
import { writeAuditLog } from "@/lib/audit/write";
import { vendorHealthStatus } from "@/lib/vendor-health/registry";
import { safeAwait } from "@/lib/db/safe-mutation";
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
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import {
  buildSystemPrompt,
  DEFAULT_PERSONA_SLUG,
} from "@/lib/personas/build-system-prompt";
import { buildDisplayableAssetsBlock } from "@/lib/ai/display-assets-block";
import { runAssetIdValidationLayer } from "@/lib/ai/hallucination-defense/asset-id-validation";
// BP32 §32.10.1 — bug-intent recognizer fires before LLM call.
import { detectBugIntent } from "@/lib/help-ai/bug-intent-recognizer";
import { resolveCustomerContext, type CustomerContextRef } from "@/lib/chat/customer-context";
// BP27 §27.4 — chat-message counter + state-machine wire-up.
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementChatMessages } from "@/lib/abuse/counters";
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
  // BP24 streaming additions (option B UX):
  //   delta_start    — client should reset the assistant bubble (clear text,
  //                    show typing indicator). Fires at the top of every
  //                    streamed attempt, including post-rewriting regens.
  //   rewriting      — supervisor flagged the draft (mid-stream or post-stream).
  //                    Client should clear the bubble and wait for the next
  //                    delta_start. Fires inside the regen loop.
  //   message_revised — final text differs from what was streamed (e.g.
  //                    asset_id_validation stripped markup). Client should
  //                    replace bubble content with the supplied final string.
  | { type: "delta_start" }
  | { type: "rewriting" }
  | { type: "message_revised"; content: string }
  | { type: "message_id"; message_id: string; conversation_id: string }
  | { type: "sources"; citations: unknown[] }
  | { type: "assets"; assets: unknown[] }
  | { type: "bug_offer"; message: string; matched_phrase: string }
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
  let body: {
    message?: string;
    conversation_id?: string | null;
    persona_slug?: string | null;
    customer_context_ref?: CustomerContextRef | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  const customerContextRef = parseCustomerContextRef(body.customer_context_ref);

  const rawUserMessage = (body.message ?? "").toString().trim();
  if (!rawUserMessage) {
    return new Response(JSON.stringify({ error: "empty_message" }), { status: 400 });
  }

  // §25.1 / audit pass 2 Finding 1 — PII redaction.
  // Customers occasionally paste SSNs, credit cards, etc. The redactor
  // replaces them with [REDACTED_<KIND>] placeholders before the text
  // reaches the LLM or the database. The downstream LLM tends to
  // respond with "I can't process sensitive numbers, please call us"
  // which is the right outcome. See lib/pii/redact.ts for design notes.
  const { redacted: userMessage, hits: piiHits } = redactPii(rawUserMessage);
  if (Object.values(piiHits).some((n) => n > 0)) {
    // Metric-style log — counts only, never the matched text.
    console.info(
      "[chat:pii] redacted=%s",
      Object.entries(piiHits)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(","),
    );
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
    customerContextRef,
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
  customerContextRef: CustomerContextRef | null;
  send: (ev: SseEvent) => Promise<void>;
  close: () => Promise<void>;
};

const VALID_CONTEXT_TYPES = new Set(["booking", "trip_itinerary", "quote"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCustomerContextRef(raw: unknown): CustomerContextRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { type?: unknown; id?: unknown };
  if (typeof r.type !== "string" || typeof r.id !== "string") return null;
  if (!VALID_CONTEXT_TYPES.has(r.type) || !UUID_RE.test(r.id)) return null;
  return { type: r.type as CustomerContextRef["type"], id: r.id };
}

async function handleChat(args: HandleChatArgs): Promise<void> {
  const svc = createServiceRoleClient();
  const { tenantId, isAuthenticated, userMessage, customerContextRef, send, close } = args;

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

      // Best-effort: generate Haiku summary and write audit + admin alert.
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
      await safeAwait(svc
        .from("customer_chat_counters")
        .update({ hard_limit_summary_audit_id: auditId })
        .eq("user_id", userId)
        .eq("tenant_id", tenantId), "customer_chat_counters.update");

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
  let conversationContactId: string | null = null;
  if (conversationId) {
    const { data: conv } = await svc
      .from("conversations")
      .select("id, active_persona_id, contact_id")
      .eq("id", conversationId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!conv) {
      await send({ type: "error", message: "conversation_not_found" });
      await close();
      return;
    }
    conversationActivePersonaId = (conv as { active_persona_id?: string } | null)?.active_persona_id ?? null;
    conversationContactId = (conv as { contact_id?: string | null } | null)?.contact_id ?? null;
  } else {
    // §15.12 sandbox: stamp is_test on the conversation row at creation time.
    // Snapshot semantics — a tenant who toggles is_sandbox later does NOT
    // retroactively flip existing rows.
    //
    // Fail CLOSED on read error: if we can't confirm the tenant is non-sandbox,
    // stamp is_test=true. The flag is immutable after insert, and the audit
    // surface (analytics dashboards, supervisor sampling) is meant to exclude
    // test traffic — mislabeling a real conversation as test under-counts real
    // metrics (recoverable), but mislabeling a sandbox conversation as real
    // corrupts the firewall (not recoverable). Bias toward over-tagging.
    const { data: sandboxRow, error: sandboxErr } = await svc
      .from("tenants")
      .select("is_sandbox")
      .eq("id", tenantId)
      .maybeSingle();
    const isTest = sandboxErr
      ? true
      : Boolean((sandboxRow as { is_sandbox?: boolean } | null)?.is_sandbox);

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
        is_test: isTest,
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
  await safeAwait(svc.from("messages").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    role: "user",
    content: userMessage,
  }), "messages.insert");

  // D-095 — load multi-turn history so the LLM sees prior context.
  // Pulls user+assistant rows in chronological order (the user message
  // just persisted above becomes the final entry). Trimmed to a char
  // budget so a runaway conversation can't blow the prompt window.
  // Computed once before the regen loop; reused across attempts so we
  // don't accidentally feed our own in-progress assistant draft back as
  // context on regen. tenantId is required (svc bypasses RLS — db-layer
  // isolation matters here).
  const chatHistory = await loadConversationHistory(svc, tenantId, conversationId);

  // BP27 §27.4 — bump chat-messages counter. Non-fatal: the message
  // already persisted; we don't want to surface a 500 over usage
  // attribution failure.
  try {
    const snapshot = await loadTenantSnapshot(svc, tenantId);
    await incrementChatMessages({ db: svc, tenant: snapshot.tenant });
  } catch (err) {
    console.warn(`[chat] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // BP32 §32.10.1 — pre-LLM bug-intent check. Surfaces an offer for the
  // customer to file a bug; the regular chat flow still runs underneath
  // so the customer gets a normal response even if they ignore the offer.
  // Gated by PHASE_2_CUSTOMER_BUG_FLOW_ENABLED + tenant_settings opt-out
  // inside detectBugIntent.
  try {
    const bug = await detectBugIntent({
      message: userMessage,
      tenant_id: tenantId,
      db: svc,
    });
    if (bug.triggered && bug.matched_phrase && bug.offer_message) {
      await send({
        type: "bug_offer",
        message: bug.offer_message,
        matched_phrase: bug.matched_phrase,
      });
    }
  } catch (err) {
    // Non-fatal: the recognizer is best-effort. Log + continue.
    console.warn("[chat] bug-intent recognizer failed:", String(err));
  }

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

  // BP39 §33.7.1 — build the DISPLAYABLE ASSETS prompt block from the
  // assets retrieveForChat surfaced (already scope-filtered + chunk-filtered).
  const displayableAssetsBlock = buildDisplayableAssetsBlock(retrieval.assets);
  const availableAssetIds = retrieval.assets.map((a) => a.asset_id);

  // §33.7 D-088 — build the PRICING ANCHORS block from the conversation's
  // entities. Reads general_pricing_ranges + applies the +10%/$100 round
  // rule. Empty string when no entities or feature flag is off.
  const { buildPricingAnchorsBlock } = await import("@/lib/pricing/build-pricing-anchors-block");
  const pricingAnchorsBlock = await buildPricingAnchorsBlock(svc, {
    cruiseLines: retrieval.entities.cruise_lines,
    ships: retrieval.entities.ships,
  });

  // §20.4 — Customer context: server-resolves the ref against the tenant.
  // A bad/cross-tenant ref returns null; we silently drop it (no error
  // surfaced to the client because context is best-effort enrichment).
  const customerContext = customerContextRef
    ? await resolveCustomerContext({ ref: customerContextRef, tenant_id: tenantId, db: svc })
    : null;

  const systemPromptBase = await buildSystemPrompt({
    persona_slug: personaSlug,
    tenant_id: tenantId,
    tenant_tier: tenantTier,
    tone_level: tone.level,
    db: svc,
    knowledge_block: retrieval.knowledge_block,
    ...(displayableAssetsBlock ? { displayable_assets_block: displayableAssetsBlock } : {}),
    ...(pricingAnchorsBlock ? { pricing_anchors_block: pricingAnchorsBlock } : {}),
    ...(customerContext ? { customer_context: customerContext } : {}),
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

  // §10.6 / D-091 Round-3 #43 — global AI kill switch. Checked BEFORE the
  // streaming wrapper is acquired so a paused AI doesn't leak partial
  // tokens to the customer or burn a vendor call. The help-AI route has
  // had this check from day one; the customer chat path was missing it,
  // which the audit flagged as a kill-switch escape in streaming mode.
  const { data: killRow } = await svc
    .from("platform_settings")
    .select("value")
    .eq("key", "ai_kill_switch_engaged")
    .maybeSingle();
  const killEngaged = killRow
    ? (killRow as { value?: unknown }).value === true ||
      (killRow as { value?: unknown }).value === "true"
    : false;
  if (killEngaged) {
    const fallbackBody =
      "Our AI is paused right now. Please leave a message and we'll be in touch.";
    await send({ type: "delta", text: fallbackBody });
    await send({ type: "supervisor", action: "allow", regens: 0 });
    await send({ type: "done" });
    await close();
    return;
  }

  // §10.6 per-tenant AI kill switch. Same fallback as the global one but
  // scoped to the resolved tenant — the platform-admin's lever for "this
  // one tenant's persona is misbehaving" without taking the whole platform
  // down. Read alongside the global check; either tripped → fallback.
  const { data: tenantKillRow } = await svc
    .from("tenants")
    .select("ai_paused_by_platform")
    .eq("id", tenantId)
    .maybeSingle();
  const tenantPaused = Boolean(
    (tenantKillRow as { ai_paused_by_platform?: boolean } | null)?.ai_paused_by_platform,
  );
  if (tenantPaused) {
    const fallbackBody =
      "Our AI is taking a brief break. A human will be in touch shortly.";
    await send({ type: "delta", text: fallbackBody });
    await send({ type: "supervisor", action: "allow", regens: 0 });
    await send({ type: "done" });
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

  // BP24 — Streaming-mode opt-in. Default off; flip CHAT_STREAMING_ENABLED=true
  // in the runtime env to route the chat reply through the streaming wrapper
  // + per-sentence supervisor (§10 option B). When off, the existing whole-
  // response + fake-stream path runs untouched.
  const streamingEnabled = process.env.CHAT_STREAMING_ENABLED === "true";

  // Per-sentence supervisor uses the same union deny-list runSupervisor
  // uses. Load it once per turn (not per attempt) to avoid 2 extra reads
  // on every regen.
  const slurDenyList = streamingEnabled
    ? await loadUnionSlurDenyList(svc, tenantId)
    : [];

  let extraInstruction = "";
  let candidate = "";
  let supervisorOutcome: SupervisorOutcome | null = null;
  let assistantMessageId: string | null = null;
  // BP24 telemetry — observability for the streaming-enabled cohort.
  let perSentenceFires = 0;
  let postStreamSupervisorFires = 0;
  let streamedAttempts = 0;

  for (let attempt = 0; attempt < REGEN_HARD_CEILING; attempt++) {
    const sys = extraInstruction ? `${systemPrompt}\n\n${extraInstruction}` : systemPrompt;

    let candidateText: string;

    if (streamingEnabled) {
      streamedAttempts++;
      // ── BP24 streaming branch — option B UX ──
      // Stream sentences directly to the client. On per-sentence flag, abort,
      // send `rewriting`, regen. The done promise still resolves with usage
      // so cost accounting stays correct even on aborted streams.
      await send({ type: "delta_start" });

      const abortController = new AbortController();
      const { textStream, done } = instrumentedClaudeStream({
        tenant_id: tenantId,
        conversation_id: conversationId,
        user_id: userId,
        model: generationModel,
        purpose: "chat_main",
        max_tokens: 1024,
        system: sys,
        messages: chatHistory,
        signal: abortController.signal,
      });

      let abortedByPerSentence = false;
      let perSentenceHashedTerm: string | undefined;

      try {
        for await (const sentence of bufferToSentences(textStream)) {
          const check = checkSentence(sentence, slurDenyList);
          if (check.hit) {
            abortController.abort();
            abortedByPerSentence = true;
            perSentenceFires++;
            perSentenceHashedTerm = check.hashedTerm;
            break;
          }
          // Append a trailing space — bufferToSentences strips inter-sentence
          // whitespace, and the client concatenates deltas verbatim.
          await send({ type: "delta", text: sentence + " " });
        }
      } catch (streamErr) {
        // Vendor failure was already recorded inside the wrapper.
        void streamErr;
        await send({
          type: "delta",
          text: "Our AI is temporarily unavailable. Please leave a message and we'll be in touch.",
        });
        await send({ type: "supervisor", action: "allow", regens: attempt });
        await send({ type: "done" });
        await close();
        return;
      }

      if (abortedByPerSentence) {
        // Let the wrapper finish its logging path (it catches the abort and
        // surfaces it as a rejection on `done`). Cost may be partial.
        try { await done; } catch { /* expected on abort */ }
        console.warn("[chat-stream] per-sentence supervisor hit", {
          conversation_id: conversationId,
          attempt,
          hashed_term: perSentenceHashedTerm,
        });
        await send({ type: "rewriting" });
        extraInstruction = HATE_SPEECH_REGEN_INSTRUCTION;
        continue;
      }

      // Stream completed cleanly. The wrapper's done promise gives us the
      // canonical text + final usage; trust it over our locally-assembled
      // string (the wrapper strips non-text content blocks consistently).
      try {
        const finalResult = await done;
        candidateText = finalResult.text;
      } catch (doneErr) {
        // Stream looked clean but final-message resolution failed (network
        // blip after last chunk). Fall back to vendor-down message rather
        // than trying to recover with partial state.
        void doneErr;
        await send({
          type: "delta",
          text: "Our AI is temporarily unavailable. Please leave a message and we'll be in touch.",
        });
        await send({ type: "supervisor", action: "allow", regens: attempt });
        await send({ type: "done" });
        await close();
        return;
      }
    } else {
      // ── Non-streaming branch ──
      // §9.6 tool-use loop: pass PERSONA_TOOLS; if the response includes
      // tool_use blocks, dispatch them and make a follow-up call with
      // tool_result blocks attached. Streaming mode does NOT yet support
      // tools — that's a follow-up since tool_use + delta buffering is
      // materially harder. Single-pass: if the follow-up itself triggers
      // another tool_use, that's the supervisor / regen's problem.
      try {
        // instrumentedClaudeCall records vendor health + ai_call_log +
        // tenant_usage_metrics increment + state-transition check.
        const baseArgs = {
          tenant_id: tenantId,
          conversation_id: conversationId,
          user_id: userId,
          model: generationModel,
          purpose: "chat_main" as const,
          max_tokens: 1024,
          system: sys,
        };
        let result = await instrumentedClaudeCall({
          ...baseArgs,
          messages: chatHistory,
          tools: PERSONA_TOOLS as unknown as AnthropicTool[],
        });

        // Tool-use loop. Returns null if no tool_use blocks — common case.
        const ctxForTools = ctx;
        if (ctxForTools) {
          const loopOut = await runToolUseLoop({
            result,
            originalMessages: chatHistory,
            dispatchCtx: {
              ctx: ctxForTools,
              db: svc,
              conversation_id: conversationId,
              contact_id: conversationContactId,
            },
          });
          if (loopOut) {
            // Follow-up call with tool_result blocks appended.
            result = await instrumentedClaudeCall({
              ...baseArgs,
              messages: loopOut.followUpMessages,
              tools: PERSONA_TOOLS as unknown as AnthropicTool[],
            });
            console.info(
              `[chat:tool-use] dispatched=${loopOut.dispatchedTools.join(",")} mutated=${loopOut.mutated}`,
            );
          }
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
        return;
      }
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
      await safeAwait(svc
        .from("messages")
        .update({ content: candidate })
        .eq("id", assistantMessageId), "messages.update");
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
    await safeAwait(svc.from("messages").insert({
      tenant_id: tenantId,
      conversation_id: conversationId,
      role: "system",
      content: escalationBody,
    }), "messages.insert");
    await safeAwait(svc
      .from("conversations")
      .update({ status: "escalated", last_message_at: new Date().toISOString() })
      .eq("id", conversationId), "conversations.update");
    await send({ type: "message_id", message_id: assistantMessageId!, conversation_id: conversationId });
    await send({ type: "done" });
    await close();
    return;
  }

  // BP39 §33.7.4 — asset_id_validation hallucination defense layer.
  // Strips any [[display_asset:<uuid>]] markup whose UUID wasn't in the
  // per-turn available set (or was malformed). Self-healing: caller streams
  // the sanitized output directly. Telemetry counters in `assetValidation`.
  const assetValidation = runAssetIdValidationLayer(candidate, availableAssetIds);
  const preValidationCandidate = candidate;
  candidate = assetValidation.output;
  if (assetValidation.severity === "warning") {
    console.warn("[chat] asset_id_validation stripped markup", {
      conversation_id: conversationId,
      message_id: assistantMessageId,
      dropped: assetValidation.metrics.dropped_count,
      malformed: assetValidation.metrics.malformed_count,
    });
    // Persist the sanitized content over the original candidate.
    await safeAwait(svc.from("messages").update({ content: candidate }).eq("id", assistantMessageId!), "messages.update");
  }

  // Surface assets to the client so it can render the [[display_asset:<id>]]
  // sentinels (BP39 hyperlink approach — see MEMORY D-075).
  if (retrieval.assets.length > 0) {
    await send({ type: "assets", assets: retrieval.assets });
  }

  await send({ type: "message_id", message_id: assistantMessageId!, conversation_id: conversationId });

  if (streamingEnabled) {
    // The content was streamed as it was generated. If asset_id_validation
    // changed the text (stripped hallucinated markup), tell the client to
    // replace the bubble with the sanitized version — option B continuity.
    if (candidate !== preValidationCandidate) {
      await send({ type: "message_revised", content: candidate });
    }
    if (streamedAttempts > 1 || perSentenceFires > 0 || postStreamSupervisorFires > 0) {
      console.info("[chat-stream] turn complete", {
        conversation_id: conversationId,
        streamed_attempts: streamedAttempts,
        per_sentence_fires: perSentenceFires,
        post_stream_supervisor_fires: postStreamSupervisorFires,
      });
    }
  } else {
    // Non-streaming branch — fake-stream the approved response word-by-word
    // so the client UX is identical regardless of which branch served the turn.
    const words = candidate.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      await send({ type: "delta", text: w });
    }
  }
  await send({ type: "done" });
  await close();

  // Bump conversation last_message_at + count.
  await safeAwait(svc
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      message_count: Math.max(1, customerCurrentCount + 1),
    })
    .eq("id", conversationId), "conversations.update");
}
