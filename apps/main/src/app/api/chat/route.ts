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
import { loadUnionSlurDenyList } from "@/lib/supervisor/load-deny-list";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { tenantContextFromRequest } from "@/lib/db/factories";
import { vendorHealthStatus } from "@/lib/vendor-health/registry";
import { safeAwait } from "@/lib/db/safe-mutation";
import { resolveChatQuota } from "@/lib/chat/resolve-chat-quota";
import { buildHelpContextBlock } from "@/lib/chat/help-context";
import {
  detectToneOverride,
  applyToneOverride,
} from "@/lib/chat/customer-tone-override";
import { resolveToneLevel } from "@/lib/chat/tone-resolution";
import { retrieveForChat } from "@/lib/rag/retrieve-for-chat";
import { loadConversationHistory } from "@/lib/chat/conversation-history";
import { buildSystemPrompt, type ChatAudience } from "@/lib/personas/build-system-prompt";
import { selectPersonaTools } from "@/lib/personas/tools";
import { resolveActivePersonaSlug } from "@/lib/personas/resolve-active-persona-slug";
import { buildDisplayableAssetsBlock } from "@/lib/ai/display-assets-block";
import { runAssetIdValidationLayer } from "@/lib/ai/hallucination-defense/asset-id-validation";
// BP32 §32.10.1 — bug-intent recognizer fires before LLM call.
import { detectBugIntent } from "@/lib/help-ai/bug-intent-recognizer";
import { resolveCustomerContext, type CustomerContextRef } from "@/lib/chat/customer-context";
// BP27 §27.4 — chat-message counter + state-machine wire-up.
import { loadTenantSnapshot, type CachedTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementChatMessages } from "@/lib/abuse/counters";
// #1586 — request-scoped config consolidation + cached platform settings.
import { loadChatTenantSettings, deriveChatTenantFlags } from "@/lib/chat/chat-tenant-settings";
import { getCachedPlatformSetting } from "@/lib/platform/platform-setting-cache";
import { runGenerationLoop } from "@/lib/chat/run-generation-loop";
import type { TenantContext } from "@/lib/db/tenant-context";
import type { SupabaseClient } from "@supabase/supabase-js";

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

type MemberIdentity = {
  ctx: TenantContext;
  userId: string;       // public.users.id (FK target)
  authUserId: string;   // auth.users.id (platform_admins key)
  customerEmail: string | null;
  role: string | null;  // public.users.role — the TA-mode boundary (#902)
};

// #860/#902 — resolve a credentialed request to a member of the resolved
// tenant. Returns null for invalid/expired sessions, non-members, and missing
// users rows. The customer path degrades null to anonymous (#860 — never
// hard-error a customer turn); the TA path hard-fails null with a 403 (#902 —
// never silently downgrade a staff request).
async function resolveMemberIdentity(
  req: Request,
  tenantId: string,
  svc: SupabaseClient,
): Promise<MemberIdentity | null> {
  try {
    const ctx = await tenantContextFromRequest(req);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
    if (!authUserId) return null;
    const { data: urow, error: uerr } = await svc
      .from("users")
      .select("id, email, role")
      .eq("auth_user_id", authUserId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    // Fail-safe (caller decides anon-vs-403) but observable: a valid session
    // that can't resolve a users.id is unexpected (tenantContextFromRequest
    // already verified membership), so surface it rather than silently degrading.
    if (uerr) console.error(`[chat] users.id lookup failed (tenant=${tenantId}): ${uerr.message}`);
    const u = urow as { id: string; email: string | null; role: string | null } | null;
    if (!u) return null;
    return { ctx, userId: u.id, authUserId, customerEmail: u.email, role: u.role };
  } catch {
    // Invalid/expired session, or an authenticated user who isn't a member
    // of this tenant.
    return null;
  }
}

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

  // ── 1. Identify caller. #860: recognize the Supabase session COOKIE (not just
  // a Bearer header) so logged-in customers hit the §24.9 customer tiers instead
  // of the anon caps. Two distinct ids matter and must NOT be conflated:
  //   • ctx.source.user_id = the AUTH id (auth.users.id) — tools/RLS need auth.uid().
  //   • userId             = public.users.id — conversations / ai_call_log /
  //     customer_* all FK users(id); writing the auth id there 500s (#850-class).
  // #902 — audience is decided by the POST handler's verification, never here:
  // a non-null taIdentity means the 403 gate already passed for this request.
  const audience: ChatAudience = args.taIdentity ? "tenant_member" : "customer";

  let ctx: TenantContext | null = null;
  let userId: string | null = null;     // public.users.id (FK target) or null
  let authUserId: string | null = null; // auth.users.id (platform_admins key)
  // Signed-in customer's account email — the ONLY address email_customer can
  // send to. Resolved here server-side; never supplied by the model.
  let customerEmail: string | null = null;

  if (args.taIdentity) {
    ({ ctx, userId, authUserId, customerEmail } = args.taIdentity);
  } else if (hasCredential) {
    // #860: null (invalid/expired session, non-member) → DEGRADE to anonymous.
    // Never hard-error a customer turn.
    const ident = await resolveMemberIdentity(args.req, tenantId, svc);
    if (ident) ({ ctx, userId, authUserId, customerEmail } = ident);
  }

  // Anonymous when no resolved member user (no credential / invalid / non-member).
  // Anon attribution rides conversation_id, not user_id.
  const anonSessionId: string | null = userId ? null : args.resolvedAnonSessionId;
  if (!userId) {
    // Forge a minimal ctx for downstream helpers that only need tenant_id.
    ctx = { tenant_id: tenantId, source: { kind: "http_request", user_id: anonSessionId! } };
  }

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

  // ── #1586 — Request-scoped tenant config. Load ONCE here and thread the
  // values through the turn instead of re-reading `tenants` (×3) /
  // `tenant_settings` (×2) / `tier_definitions` (×1) at each use site.
  //   • loadTenantSnapshot is 30s-cached and shared with the §27 counters; it
  //     now also surfaces is_sandbox + ai_paused_by_platform, so the sandbox
  //     stamp and the per-tenant AI kill switch come from this one read.
  //   • loadChatTenantSettings reads tenant_settings once (tone cap + profanity).
  // `configDbReads` counts the config-phase round-trips actually issued (cache
  // hits cost 0) for the [chat:perf] log below — the #1586 acceptance signal.
  let configDbReads = 0;
  const bumpConfigReads = (): void => {
    configDbReads += 1;
  };

  let snapshot: CachedTenantSnapshot | null = null;
  try {
    snapshot = await loadTenantSnapshot(svc, tenantId, bumpConfigReads);
  } catch (err) {
    // Non-fatal (matches the prior inline reads): degrade to fail-closed
    // defaults — is_test=true (over-tag), not paused, base tier.
    console.warn("[chat] tenant snapshot load failed (non-fatal):", sanitizeForLog(err));
  }
  // Fail-closed (is_sandbox → is_test) / fail-open (pause) derivation lives in a
  // pure, unit-tested helper so the security-critical defaults can't silently
  // invert. See deriveChatTenantFlags.
  const { tenantTier, isSandbox: tenantIsSandbox, aiPausedByPlatform: tenantAiPaused } =
    deriveChatTenantFlags(snapshot);

  const { personaToneMaxLevel: tenantMaxTone, allowProfanity: tenantAllowProfanity } =
    await loadChatTenantSettings(svc, tenantId, bumpConfigReads);

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

  // ── 4. Load or create conversation; persist user message.
  let conversationId = args.conversationIdInput;
  let conversationActivePersonaId: string | null = null;
  let conversationContactId: string | null = null;
  if (conversationId) {
    // #902: the audience filter blocks cross-register continuation — a TA
    // continuing a customer thread (or vice versa) would leak the wrong
    // Layer-2 rules into an existing transcript.
    const { data: conv } = await svc
      .from("conversations")
      .select("id, active_persona_id, contact_id")
      .eq("id", conversationId)
      .eq("tenant_id", tenantId)
      .eq("audience", audience)
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
    // retroactively flip existing rows. #1586: is_sandbox now comes from the
    // request-scoped tenant snapshot (fail-closed to true on snapshot failure).
    const isTest = tenantIsSandbox;

    const { data: created, error: createErr } = await svc
      .from("conversations")
      .insert({
        tenant_id: tenantId,
        user_id: userId,
        anonymous_session_id: !userId ? anonSessionId : null,
        audience,
        status: "active",
        first_message_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        message_count: 0,
        is_test: isTest,
      })
      .select("id")
      .single();
    if (createErr || !created) {
      // F-leak-01: generic message + server-logged ref, never the raw DB error.
      const ref = randomUUID();
      console.error("[chat] ref=%s conversation_create_failed", ref, createErr);
      await send({ type: "error", message: "Something went wrong", ref });
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
  // attribution failure. #1586: reuses the request-scoped snapshot loaded above
  // (no second `tenants` read). Skipped when the snapshot load failed.
  if (snapshot) {
    try {
      await incrementChatMessages({ db: svc, tenant: snapshot.tenant });
    } catch (err) {
      console.warn(`[chat] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // BP32 §32.10.1 — pre-LLM bug-intent check. Surfaces an offer for the
  // customer to file a bug; the regular chat flow still runs underneath
  // so the customer gets a normal response even if they ignore the offer.
  // Gated by PHASE_2_CUSTOMER_BUG_FLOW_ENABLED inside detectBugIntent (#1190
  // removed the per-tenant tenant_settings opt-out).
  try {
    // #902: customer-facing offer only — TA bug reporting lives in the help
    // flows, not as a chat interrupt.
    const bug = audience === "customer"
      ? await detectBugIntent({
          message: userMessage,
          db: svc,
        })
      : { triggered: false as const, matched_phrase: null, offer_message: null };
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
  // §24.6 precedence: switched persona (conversation.active_persona_id) wins
  // over the request body, which wins over the default. See resolver.
  const personaSlug = await resolveActivePersonaSlug(svc, {
    activePersonaId: conversationActivePersonaId,
    requestedSlug: args.personaSlugInput,
  });

  // #1586 — tenantTier / tenantMaxTone / tenantAllowProfanity are resolved once
  // in the request-scoped config block above (from the cached snapshot +
  // single tenant_settings read); no per-use re-reads here.

  let customerRapportLevel: number | null = null;
  let customerRapportDirective: "direct" | null = null;
  if (userId && audience === "customer") {
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
  // Build conversation context for entity extraction: last 4 history entries,
  // trimmed so follow-up questions like "send the deck plan" can resolve back
  // to the ship being discussed without re-mentioning it.
  const contextMessages = chatHistory
    .slice(-4)
    .map((m) => {
      const text = typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type?: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(" ");
      return { role: m.role as "user" | "assistant", text: text.slice(0, 250) };
    })
    .filter((m) => m.text.trim().length > 0);

  const retrieval = await retrieveForChat({
    message: userMessage,
    tenant_id: tenantId,
    // #850 — user_id MUST be a real users.id or null. ai_call_log.user_id has an
    // FK to users(id), and entity_extraction's wrapper writes that row mid-retrieval.
    // Passing the anon session id here FK-violated the insert → extraction threw →
    // empty entities → the concierge ignored ship+date itinerary data on every
    // anonymous turn. Anon attribution is carried by conversation_id
    // (conversations.anonymous_session_id), never user_id.
    user_id: userId,
    conversation_id: conversationId,
    persona_id: personaSlug,
    // #902: the closed-promo gate hides promos from non-booked CUSTOMERS;
    // a staff member is entitled to see their own tenant's promos.
    customer_has_booking: audience === "tenant_member",
    context_messages: contextMessages,
  });

  await send({ type: "persona", slug: personaSlug, display_name: personaSlug });
  if (retrieval.citations.length > 0) {
    await send({ type: "sources", citations: retrieval.citations });
  }

  // ── 7. Resolve tone and build system prompt.
  // #902: TA mode pins professional tone (D-195) — customer rapport memory and
  // message-driven tone resolution are customer-audience machinery.
  const tone = audience === "tenant_member"
    ? { level: 2 }
    : resolveToneLevel({
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
  const customerContext = audience === "customer" && customerContextRef
    ? await resolveCustomerContext({ ref: customerContextRef, tenant_id: tenantId, db: svc })
    : null;

  // #902 — PLATFORM HELP CONTEXT is built ONLY on the TA branch: customer
  // prompts structurally never contain platform-internals content.
  const helpContextBlock = audience === "tenant_member"
    ? buildHelpContextBlock(userMessage, tenantTier)
    : null;

  const systemPromptBase = await buildSystemPrompt({
    persona_slug: personaSlug,
    tenant_id: tenantId,
    tenant_tier: tenantTier,
    tone_level: tone.level,
    db: svc,
    audience,
    knowledge_block: retrieval.knowledge_block,
    ...(displayableAssetsBlock ? { displayable_assets_block: displayableAssetsBlock } : {}),
    ...(pricingAnchorsBlock ? { pricing_anchors_block: pricingAnchorsBlock } : {}),
    ...(customerContext ? { customer_context: customerContext } : {}),
    ...(helpContextBlock ? { help_context_block: helpContextBlock } : {}),
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
  // #1586 — served from the shared 60s platform_settings cache. A ≤60s
  // propagation delay is acceptable (it already races in-flight streams).
  // Fail-open preserved: a read error → value null → not engaged.
  const { value: killValue } = await getCachedPlatformSetting(
    svc,
    "ai_kill_switch_engaged",
    bumpConfigReads,
  );
  const killEngaged = killValue === true || killValue === "true";
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
  // down. #1586: read from the request-scoped snapshot (≤30s propagation,
  // acceptable per the issue) instead of a third `tenants` read.
  if (tenantAiPaused) {
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

  // #1586 — config-phase DB round-trips actually issued before first token
  // (cache hits cost 0). Pre-fix this path re-read tenants ×3 / tenant_settings
  // ×2 / tier_definitions ×1 / platform_settings ×1-2; now it is ≤3 cold, 0-1
  // warm. Scoped to the consolidated config reads, NOT the whole turn.
  console.info(
    "[chat:perf] config_db_reads=%d conversation_id=%s",
    configDbReads,
    conversationId,
  );

  const generationModel = process.env.CHAT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";
  // #902 — separate cost attribution for TA turns (and TA accepts the
  // soft-tier model downgrade; see AICallPurpose).
  const chatPurpose = audience === "tenant_member" ? ("ta_chat_main" as const) : ("chat_main" as const);

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

  // ── 8b. Generation + supervisor regen loop (#1016 — see runGenerationLoop).
  // On "aborted" the loop already sent the terminal SSE events and closed.
  const gen = await runGenerationLoop({
    svc,
    // Non-null: every identity path above sets ctx (anon turns forge one in §1).
    ctx: ctx!,
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
  let candidate = gen.candidate;

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
    await send({ type: "message_id", message_id: assistantMessageId, conversation_id: conversationId });
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
    await safeAwait(svc.from("messages").update({ content: candidate }).eq("id", assistantMessageId).eq("tenant_id", tenantId), "messages.update");
  }

  // Surface assets to the client so it can render the [[display_asset:<id>]]
  // sentinels (BP39 hyperlink approach — see MEMORY D-075).
  if (retrieval.assets.length > 0) {
    await send({ type: "assets", assets: retrieval.assets });
  }

  await send({ type: "message_id", message_id: assistantMessageId, conversation_id: conversationId });

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
