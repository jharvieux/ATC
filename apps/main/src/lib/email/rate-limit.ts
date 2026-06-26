// §23.6 — Email rate limit checker.
//
// Categories and limits:
//   transactional    — always allowed (must-send)
//   pre_cruise       — bound to schedule; not subject to general limits
//   group_invitation — 3 / 24h per invitee (enforced in group-reminder-cadence.ts)
//   marketing        — 4 / month per contact
//   travel_news      — weekly digest (1 / 7 days per contact)
//   admin_sample     — 50 / 24h platform-wide (admin test sends)
//   template_preview — 10 / 24h per tenant (owner "send to me" test sends)
//   concierge        — AI-driven send (email_customer tool): 10 / 24h per recipient

import type { SupabaseClient } from "@supabase/supabase-js";

export type EmailCategory =
  | "transactional"
  | "pre_cruise"
  | "group_invitation"
  | "marketing"
  | "travel_news"
  | "admin_sample"
  | "template_preview"
  | "concierge";

// AI-driven concierge sends are bounded per recipient per 24h. The recipient is
// always the signed-in account holder, so this caps an abused/looping chat
// session from fan-out spamming the customer's own inbox.
const CONCIERGE_DAILY_LIMIT = 10;

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

export async function checkRateLimit(opts: {
  db: SupabaseClient;
  tenant_id: string;
  to_email: string;
  category: EmailCategory;
}): Promise<RateLimitResult> {
  const { db, tenant_id, to_email, category } = opts;

  if (category === "transactional" || category === "pre_cruise" || category === "group_invitation") {
    return { allowed: true };
  }

  const now = new Date();

  if (category === "admin_sample") {
    // 50 total admin sample sends per 24h (platform-wide, not per-recipient).
    // to_email is intentionally unused here — the cap is a global send budget,
    // not a per-address throttle, so counting across all destinations is correct.
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("email_log")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("email_category", "admin_sample")
      .gte("sent_at", dayAgo)
      .not("status", "eq", "suppressed");
    if (error) return { allowed: false, reason: "rate_limit_query_failed" };
    if ((data?.length ?? 0) >= 50) {
      return { allowed: false, reason: "admin_sample_daily_limit_reached" };
    }
    return { allowed: true };
  }

  if (category === "template_preview") {
    // Cap is per-tenant, not per-recipient — the feature always sends to the
    // logged-in owner's inbox, so recipient-level throttling adds nothing.
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("email_log")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("email_category", "template_preview")
      .gte("sent_at", dayAgo)
      .not("status", "eq", "suppressed");
    if (error) return { allowed: false, reason: "rate_limit_query_failed" };
    if ((data?.length ?? 0) >= 10) {
      return { allowed: false, reason: "template_preview_daily_limit_reached" };
    }
    return { allowed: true };
  }

  if (category === "marketing") {
    // 4 per calendar month
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const { data, error } = await db
      .from("email_log")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("to_email", to_email)
      .eq("email_category", "marketing")
      .gte("sent_at", monthStart)
      .not("status", "eq", "suppressed");
    if (error) return { allowed: false, reason: "rate_limit_query_failed" };
    if ((data?.length ?? 0) >= 4) {
      return { allowed: false, reason: "marketing_monthly_limit_reached" };
    }
    return { allowed: true };
  }

  if (category === "travel_news") {
    // 1 per 7 days
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("email_log")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("to_email", to_email)
      .eq("email_category", "travel_news")
      .gte("sent_at", weekAgo)
      .not("status", "eq", "suppressed");
    if (error) return { allowed: false, reason: "rate_limit_query_failed" };
    if ((data?.length ?? 0) >= 1) {
      return { allowed: false, reason: "travel_news_weekly_limit_reached" };
    }
    return { allowed: true };
  }

  if (category === "concierge") {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("email_log")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("to_email", to_email)
      .eq("email_category", "concierge")
      .gte("sent_at", dayAgo)
      .not("status", "eq", "suppressed");
    if (error) return { allowed: false, reason: "rate_limit_query_failed" };
    if ((data?.length ?? 0) >= CONCIERGE_DAILY_LIMIT) {
      return { allowed: false, reason: "concierge_daily_limit_reached" };
    }
    return { allowed: true };
  }

  // unreachable — all EmailCategory variants are handled above
  return { allowed: false, reason: "unknown_category" };
}
