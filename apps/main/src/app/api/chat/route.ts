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

import {
  ANON_SESSION_COOKIE,
  buildAnonCookieHeader,
  freshAnonSession,
  verifyAnonSession,
} from "@/lib/chat/anon-session-cookie";
import { randomUUID } from "node:crypto";
import { redactPii } from "@/lib/pii/redact";
import { sanitizeForLog } from "@/lib/log/sanitize";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { safeAwait } from "@/lib/db/safe-mutation";
import { resolveChatQuota } from "@/lib/chat/resolve-chat-quota";
import {
  detectToneOverride,
  applyToneOverride,
} from "@/lib/chat/customer-tone-override";
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import { type ChatAudience } from "@/lib/personas/build-system-prompt";
import { selectPersonaTools } from "@/lib/personas/tools";
import { type CustomerContextRef } from "@/lib/chat/customer-context";
// BP27 §27.4 — chat-message counter + state-machine wire-up.
import { incrementChatMessages } from "@/lib/abuse/counters";
import { runGenerationLoop } from "@/lib/chat/run-generation-loop";
import {
  resolveChatIdentity,
  resolveMemberIdentity,
  type MemberIdentity,
} from "@/lib/chat/resolve-chat-identity";
import { loadOrCreateConversation } from "@/lib/chat/load-or-create-conversation";
import { buildPromptContext } from "@/lib/chat/build-prompt-context";
import { deliverChatResponse } from "@/lib/chat/deliver-chat-response";
import { loadRequestScopedConfig } from "@/lib/chat/load-request-scoped-config";
import { maybeSendBugOffer } from "@/lib/chat/maybe-send-bug-offer";
import { prepareGeneration } from "@/lib/chat/prepare-generation";

const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

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
  // `ref` correlates a client-reported failure to the server log line holding
  // the real (possibly DB-internal) error — the error text is never streamed.
  | { type: "error"; message: string; ref?: string };

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
    // #902 — "ta" requests the tenant_member audience; the server VERIFIES
    // eligibility below. Any other value is ignored (customer mode).
    mode?: string | null;
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
  if (rawUserMessage.length > 8000) {
    return new Response(JSON.stringify({ error: "message_too_long" }), { status: 400 });
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

  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId || tenantId === "platform") {
    return new Response(
      JSON.stringify({ error: "tenant_not_resolved" }),
      { status: 400 },
    );
  }

  // #860 — a request carries an auth credential if it has a Bearer token OR a
  // Supabase session cookie (sb-<ref>-auth-token, possibly chunked). The cookie
  // is the authoritative session source post-§17.x; the old Bearer-only check
  // treated every logged-in customer as anonymous. We only PRESENCE-check here
  // (synchronous); the cookie is validated async inside handleChat.
  const cookies = parseCookies(req.headers.get("cookie"));
  const hasBearer = req.headers.get("authorization")?.startsWith("Bearer ") ?? false;
  const hasAuthCookie = Object.keys(cookies).some((n) => /^sb-.*-auth-token/.test(n));
  const hasCredential = hasBearer || hasAuthCookie;

  // ── Resolve an anonymous session id for the anon (or invalid-session) path.
  //    Only SET the anon cookie when there's no credential — an authenticated
  //    turn must not be issued an anon session cookie.
  let resolvedAnonSessionId: string | null = null;
  let anonCookieHeader: string | null = null;
  {
    const rawAnon = cookies[ANON_SESSION_COOKIE] ?? null;
    const verifiedId = rawAnon ? await verifyAnonSession(rawAnon) : null;
    if (verifiedId) {
      resolvedAnonSessionId = verifiedId;
    } else {
      const fresh = await freshAnonSession();
      resolvedAnonSessionId = fresh.id;
      if (!hasCredential) anonCookieHeader = buildAnonCookieHeader(fresh.cookieValue);
    }
  }

  // #902 / D-195 — TA mode (audience='tenant_member'). Verified BEFORE the
  // SSE stream exists so ineligible callers get a real 403, not a 200 stream
  // carrying an error event. Fail closed: anything short of a verified
  // tenant_owner/agent membership in the resolved tenant is refused — never
  // silently downgraded to customer mode (a downgrade would answer in the
  // wrong register and mask the misconfiguration). Customers are viewer-role
  // members, so ROLE — not membership — is the boundary.
  let taIdentity: MemberIdentity | null = null;
  if (body.mode === "ta") {
    taIdentity = hasCredential
      ? await resolveMemberIdentity(req, tenantId, createServiceRoleClient())
      : null;
    if (!taIdentity || (taIdentity.role !== "tenant_owner" && taIdentity.role !== "agent")) {
      return new Response(JSON.stringify({ error: "ta_mode_forbidden" }), { status: 403 });
    }
  }

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

  // allow-void-async: SSE handler — the chat logic must run after the Response
  // returns with the readable stream attached; rejections are handled by the .catch below.
  void handleChat({
    req,
    tenantId,
    hasCredential,
    resolvedAnonSessionId,
    taIdentity,
    userMessage,
    conversationIdInput: body.conversation_id ?? null,
    personaSlugInput: body.persona_slug ?? null,
    customerContextRef,
    send,
    close,
  }).catch(async (err) => {
    // F-leak-01: log the real error server-side under a correlation ref; stream
    // only a generic message so DB/internal details never reach the (anonymous)
    // caller. supabase-js / Postgres error messages embed table/column names.
    const ref = randomUUID();
    // #1412: sanitize before logging — err can embed user-provided text with
    // CR/LF that would otherwise forge extra log lines (CWE-117).
    console.error("[chat] ref=%s error=%s", ref, sanitizeForLog(err));
    try {
      await send({ type: "error", message: "Something went wrong", ref });
    } finally {
      await close();
    }
  });

  const responseHeaders: HeadersInit = anonCookieHeader
    ? { ...SSE_HEADERS, "Set-Cookie": anonCookieHeader }
    : SSE_HEADERS;
  return new Response(readable, { status: 200, headers: responseHeaders });
}

// ────────────────────────────────────────────────────────────────────────────
// Core chat orchestration
// ────────────────────────────────────────────────────────────────────────────

type HandleChatArgs = {
  req: Request;
  tenantId: string;
  hasCredential: boolean;
  resolvedAnonSessionId: string | null;
  // #902 — non-null ⇔ the POST handler verified a tenant_owner/agent member
  // requesting TA mode. Carries the already-resolved identity so handleChat
  // doesn't re-resolve (and can't disagree with what was verified).
  taIdentity: MemberIdentity | null;
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
  const { tenantId, hasCredential, userMessage, customerContextRef, send, close } = args;

  // ── 1. Identify caller (see resolveChatIdentity). #860: two distinct ids —
  // authUserId (auth.users.id, tools/RLS) and userId (public.users.id, the FK
  // target) — must NOT be conflated (writing the auth id into a users(id) FK
  // 500s, #850-class). The discriminated union means ctx is always non-null.
  // #902 — audience is decided by the POST handler's verification, never here:
  // a non-null taIdentity means the 403 gate already passed for this request.
  const audience: ChatAudience = args.taIdentity ? "tenant_member" : "customer";

  const identity = await resolveChatIdentity({
    req: args.req,
    tenantId,
    hasCredential,
    taIdentity: args.taIdentity,
    resolvedAnonSessionId: args.resolvedAnonSessionId,
    svc,
  });
  const ctx = identity.ctx;
  const userId = identity.kind === "member" ? identity.userId : null;
  const authUserId = identity.kind === "member" ? identity.authUserId : null;
  // Signed-in customer's account email — the ONLY address email_customer can
  // send to. Resolved server-side; never supplied by the model.
  const customerEmail = identity.kind === "member" ? identity.customerEmail : null;
  // Anon attribution rides conversation_id, not user_id.
  const anonSessionId = identity.kind === "anon" ? identity.anonSessionId : null;

  // ── 2. Rate limit (#1015 — see resolveChatQuota). #860: platform admins
  // bypass entirely (unmetered; costs are still logged). Authenticated
  // members → §24.9 customer tiers. Else → anon caps.
  const quota = await resolveChatQuota({
    svc,
    req: args.req,
    tenantId,
    audience,
    userId,
    authUserId,
    anonSessionId,
  });
  if (!quota.allowed) {
    await send(quota.blockedResponse);
    await send({ type: "done" });
    await close();
    return;
  }
  const { personaAugmentation, customerCurrentCount } = quota;

  // ── #1586 — Request-scoped tenant config, loaded ONCE and threaded through
  // the turn instead of re-reading `tenants` (×3) / `tenant_settings` (×2) /
  // `tier_definitions` (×1) at each use site. `configDbReads` counts the
  // config-phase round-trips actually issued (cache hits cost 0) for the
  // [chat:perf] log below — the #1586 acceptance signal. See
  // loadRequestScopedConfig for the phase detail (extracted from handleChat);
  // resolveAiAvailability (phase 8) also bumps this shared counter.
  let configDbReads = 0;
  const bumpConfigReads = (): void => {
    configDbReads += 1;
  };
  const {
    snapshot,
    tenantTier,
    tenantIsSandbox,
    tenantAiPaused,
    tenantMaxTone,
    tenantAllowProfanity,
  } = await loadRequestScopedConfig(svc, tenantId, bumpConfigReads);

  // ── 3. Detect customer tone-change (authenticated only — anon has no memory).
  // #902: customer audience only — TA mode pins tone and has no rapport memory.
  if (userId && audience === "customer") {
    const override = detectToneOverride(userMessage);
    if (override) {
      await applyToneOverride(svc, {
        tenant_id: tenantId,
        user_id: userId,
        action: override,
        tenant_max_level: tenantMaxTone,
      });
    }
  }

  // ── 4. Load or create conversation; persist user message. #1586: is_test
  // (sandbox stamp) comes from the request-scoped tenant snapshot, fail-closed
  // to true on snapshot failure.
  const convResult = await loadOrCreateConversation({
    svc,
    tenantId,
    audience,
    conversationIdInput: args.conversationIdInput,
    userId,
    anonSessionId,
    isTest: tenantIsSandbox,
  });
  if (!convResult.ok) {
    if (convResult.reason === "not_found") {
      await send({ type: "error", message: "conversation_not_found" });
    } else {
      // F-leak-01: generic message + server-logged ref, never the raw DB error.
      await send({ type: "error", message: "Something went wrong", ref: convResult.ref });
    }
    await close();
    return;
  }
  const conversationId = convResult.conversationId;
  const conversationActivePersonaId = convResult.activePersonaId;
  const conversationContactId = convResult.contactId;

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
  // attribution failure. #1586: reuses the request-scoped snapshot loaded above
  // (no second `tenants` read). Skipped when the snapshot load failed.
  if (snapshot) {
    try {
      await incrementChatMessages({ db: svc, tenant: snapshot.tenant });
    } catch (err) {
      console.warn(`[chat] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // BP32 §32.10.1 — pre-LLM bug-intent check (see maybeSendBugOffer, extracted
  // from handleChat). Best-effort: the regular chat flow still runs underneath
  // so the customer gets a normal response even if the offer isn't sent.
  await maybeSendBugOffer({ audience, userMessage, svc, send });

  // ── 5-7. Resolve persona/tone, RAG retrieve, and build the system prompt.
  // #1586 — tenantTier / tenantMaxTone / tenantAllowProfanity are resolved once
  // in the request-scoped config block above (from the cached snapshot +
  // single tenant_settings read); no per-use re-reads here. See
  // buildPromptContext for the phase detail (extracted from handleChat).
  const { personaSlug, systemPrompt, retrieval, availableAssetIds } = await buildPromptContext({
    svc,
    tenantId,
    audience,
    userId,
    conversationId,
    chatHistory,
    userMessage,
    personaSlugInput: args.personaSlugInput,
    conversationActivePersonaId,
    tenantTier,
    tenantMaxTone,
    customerContextRef,
    personaAugmentation,
    send,
  });

  // ── 8. Pre-generation gates (API key, AI kill-switches) + generation
  // config. See prepareGeneration for the phase detail (extracted from
  // handleChat). On !ready, terminal SSE events are already sent + closed.
  const prep = await prepareGeneration({ svc, tenantId, audience, tenantAiPaused, bumpConfigReads, send, close });
  if (!prep.ready) return;
  const { generationModel, chatPurpose, streamingEnabled, slurDenyList } = prep;

  // #1586 — config-phase DB round-trips actually issued before first token
  // (cache hits cost 0). Pre-fix this path re-read tenants ×3 / tenant_settings
  // ×2 / tier_definitions ×1 / platform_settings ×1-2; now it is ≤3 cold, 0-1
  // warm. Scoped to the consolidated config reads, NOT the whole turn.
  console.info(
    "[chat:perf] config_db_reads=%d conversation_id=%s",
    configDbReads,
    conversationId,
  );

  // ── 8b. Generation + supervisor regen loop (#1016 — see runGenerationLoop).
  // On "aborted" the loop already sent the terminal SSE events and closed.
  const gen = await runGenerationLoop({
    svc,
    // resolveChatIdentity always returns a non-null ctx (anon turns forge one).
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
    // BYO tenants / TA-mode turns never see the "our booking system" tools — the
    // concierge grounds sailing questions in the RAG itinerary data instead.
    tools: selectPersonaTools({ audience, tenantTier }),
    slurDenyList,
    retrieval,
    tenantMaxTone,
    tenantAllowProfanity,
    send,
    close,
  });
  if (gen.status === "aborted") return;
  const {
    supervisorOutcome,
    assistantMessageId,
    streamedAttempts,
    perSentenceFires,
    postStreamSupervisorFires,
  } = gen;
  const candidate = gen.candidate;

  await send({
    type: "supervisor",
    action: supervisorOutcome?.action ?? "allow",
    regens: supervisorOutcome?.regen_count ?? 0,
  });

  // ── 9. Final delivery — escalation branch, asset_id_validation, and the
  // streaming-vs-fake-stream emit. See deliverChatResponse (extracted from
  // handleChat).
  await deliverChatResponse({
    svc,
    tenantId,
    conversationId,
    assistantMessageId,
    candidate,
    supervisorOutcome,
    availableAssetIds,
    retrievedAssets: retrieval.assets,
    streamingEnabled,
    streamedAttempts,
    perSentenceFires,
    postStreamSupervisorFires,
    customerCurrentCount,
    send,
    close,
  });
}
