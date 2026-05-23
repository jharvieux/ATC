// §23.6 — Email rate limit checker.
//
// Categories and limits:
//   transactional    — always allowed (must-send)
//   pre_cruise       — bound to schedule; not subject to general limits
//   group_invitation — 3 / 24h per invitee (enforced in group-reminder-cadence.ts)
//   marketing        — 4 / month per contact
//   travel_news      — weekly digest (1 / 7 days per contact)

import type { SupabaseClient } from "@supabase/supabase-js";

export type EmailCategory =
  | "transactional"
  | "pre_cruise"
  | "group_invitation"
  | "marketing"
  | "travel_news";

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

  return { allowed: true };
}
