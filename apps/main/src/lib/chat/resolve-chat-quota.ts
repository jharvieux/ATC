// #1015 — chat quota/gating decision, extracted verbatim from handleChat.
//
// One call answers "may this turn proceed, and on what terms?" for all four
// caller classes:
//   platform admin → unmetered bypass (#860; fail-closed on lookup error)
//   tenant member  → TA daily backstop cap (#902 / D-195)
//   customer       → §24.9 three-tier limit (soft tiers feed the prompt)
//   anonymous      → §24.8 three-identifier caps → signup wall
//
// Side effects on the blocked paths (burst recording, hard-limit audit trail)
// live here with the decision that triggers them. The caller owns the SSE
// stream: a blocked decision carries the exact event to send.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/audit/write";
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
import { enforceTaDailyLimit } from "@/lib/chat/ta-daily-limit";
import { deriveFingerprint, extractClientIp } from "@/lib/chat/fingerprint";
import type { ChatAudience } from "@/lib/personas/build-system-prompt";

export type ChatQuotaBlockedEvent =
  | { type: "hard_limit"; body: string; reset_at: string }
  | { type: "signup_wall"; body: string };

export type ChatQuotaDecision =
  | {
      allowed: true;
      // §24.9 Soft1/Soft2 in-character nudge for the system prompt; null otherwise.
      personaAugmentation: string | null;
      // Current metered count (customer/TA paths); 0 for admin bypass and anon.
      customerCurrentCount: number;
    }
  | { allowed: false; blockedResponse: ChatQuotaBlockedEvent };

export type ResolveChatQuotaArgs = {
  svc: SupabaseClient;
  req: Request;
  tenantId: string;
  audience: ChatAudience;
  userId: string | null;     // public.users.id — null ⇔ anonymous
  authUserId: string | null; // auth.users.id — platform_admins key
  anonSessionId: string | null;
};

export async function resolveChatQuota(args: ResolveChatQuotaArgs): Promise<ChatQuotaDecision> {
  const { svc, tenantId, audience, userId, authUserId, anonSessionId } = args;

  // #860 staff bypass: platform admins (keyed by the auth id) chat unmetered —
  // costs are still logged downstream. Fail-closed: a lookup error → no bypass.
  let isPlatformAdmin = false;
  if (authUserId) {
    const { data: adminRow, error: adminErr } = await svc
      .from("platform_admins")
      .select("auth_user_id")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    // Fail-closed (no bypass on error) but observable — matches assertPlatformAdmin.
    if (adminErr) console.error(`[chat] platform_admins lookup failed (tenant=${tenantId}): ${adminErr.message}`);
    isPlatformAdmin = Boolean(adminRow);
  }

  if (isPlatformAdmin) {
    // Staff bypass — no rate limiting for internal testers.
    return { allowed: true, personaAugmentation: null, customerCurrentCount: 0 };
  }

  if (audience === "tenant_member") {
    // #902 — TA daily backstop cap (operator: 200/day default; the tenant
    // AI-cost state machine is the primary spend governor). Fail-closed:
    // a count failure denies the turn rather than running uncapped.
    const decision = await enforceTaDailyLimit(svc, { tenant_id: tenantId, user_id: userId! });
    if (!decision.allowed) {
      const resetAt = new Date();
      resetAt.setUTCHours(24, 0, 0, 0);
      const bodyText =
        decision.reason === "cap"
          ? `Daily chat limit reached (${decision.cap} messages). It resets at midnight UTC.`
          : "Chat is temporarily unavailable. Please try again in a few minutes.";
      return {
        allowed: false,
        blockedResponse: { type: "hard_limit", body: bodyText, reset_at: resetAt.toISOString() },
      };
    }
    return { allowed: true, personaAugmentation: null, customerCurrentCount: decision.current_count };
  }

  if (userId) {
    const decision = await enforceCustomerLimit(svc, { user_id: userId, tenant_id: tenantId });
    if (decision.tier === "hard") {
      // §24.9 system-spoken hard-limit message — NOT in-character.
      const resetAtPretty = new Date(decision.reset_at).toLocaleDateString();
      const sysBody =
        "Chat limit reached. You've reached the message limit for this billing period. " +
        "To continue chatting, you can book a cruise (which doubles your quota while you have " +
        "an upcoming trip) or request a handoff to a trip consultant. " +
        `Your quota resets ${resetAtPretty}.`;

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

      return {
        allowed: false,
        blockedResponse: { type: "hard_limit", body: sysBody, reset_at: decision.reset_at },
      };
    }
    // Soft1 / Soft2 → persona augmentation feeds the prompt; below tier just proceeds.
    return {
      allowed: true,
      personaAugmentation:
        decision.tier === "soft1" || decision.tier === "soft2"
          ? decision.persona_augmentation
          : null,
      customerCurrentCount: decision.current_count,
    };
  }

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
    return {
      allowed: false,
      blockedResponse: {
        type: "signup_wall",
        body:
          "You've reached the free chat limit for this session. " +
          "Sign up to keep chatting — it's free and your conversation will be transferred.",
      },
    };
  }
  await incrementAnonCounters(svc, {
    tenant_id: tenantId,
    session_id: anonSessionId!,
    ip,
    fingerprint,
  });
  return { allowed: true, personaAugmentation: null, customerCurrentCount: 0 };
}
