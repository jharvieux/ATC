// Admin Console home dashboard aggregate.
//
// GET /api/tenant/dashboard — one round-trip that backs the console landing
// page: workspace identity, this-month stats, setup-checklist completion,
// recent audit activity, and the current plan/health summary.
//
// Each sub-query runs in its own try/catch and degrades to a safe default
// (0 / false / empty) on failure — a missing table or a single failed read
// must never blank the whole dashboard or throw (D-091 #2, fail-closed to a
// safe value rather than a 500). assertPermission is the auth gate.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { loadPricingTable, tierMonthlyPriceCents } from "@/lib/pricing/pricing-table";
import { respondToAuthError } from "@/lib/auth/respond";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/db/tenant-context";

interface DashboardPayload {
  workspace: {
    name: string;
    owner_first_name: string;
    date: string;
  };
  stats: {
    conversations_this_month: number;
    conversations_prev_month: number;
    ai_messages_this_month: number;
    chat_limit_used: number;
    chat_limit_cap: number;
    chat_limit_reset_date: string;
    seat_count: number;
    seats_in_use: number;
  };
  setup: {
    host_connected: boolean;
    branding_set: boolean;
    personas_customized: boolean;
    team_member_invited: boolean;
    email_templates_set: boolean;
    ai_mode_set: boolean;
  };
  activity: Array<{
    id: string;
    action: string;
    description: string;
    created_at: string;
  }>;
  plan: {
    tier_code: string | null;
    tier_name: string | null;
    price_monthly: number | null;
    billing_period: string | null;
    status: string;
  };
}

function monthRange(offset: number): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function firstOfNextMonthISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

// Humanize an audit action key ("tenant.ai-config.updated") into a sentence
// fragment. The action itself is the source of truth; this is presentation.
function describeAction(action: string): string {
  const map: Record<string, string> = {
    "tenant.ai-config.updated": "AI mode updated",
    "tenant_branding.updated": "Branding updated",
    "host_config.updated": "Host integration updated",
    "team_member.role_updated": "Team member role changed",
    "team_member.invited": "Team member invited",
    "persona_addendum.updated": "AI persona updated",
    "email_templates.updated": "Email template updated",
  };
  if (map[action]) return map[action];
  return action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function countConversations(
  db: SupabaseClient,
  tenantId: string,
  range: { start: string; end: string },
): Promise<number> {
  try {
    const { count, error } = await db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", range.start)
      .lt("created_at", range.end);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function GET(req: Request): Promise<Response> {
  let ctx: TenantContext;
  let userId: string | null;
  try {
    const auth = await assertPermission(req, { resource: "TenantUsage", action: "read" });
    ctx = auth.ctx;
    userId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
  } catch (err) {
    return respondToAuthError(err);
  }

  const db = tenantClient(ctx);
  const thisMonth = monthRange(0);
  const prevMonth = monthRange(-1);

  // ── Workspace identity ───────────────────────────────────────────────────
  let workspaceName = "Your workspace";
  let tenantTierId: string | null = null;
  let seatCount = 1;
  let billingPeriod: string | null = null;
  let tenantStatus = "active";
  let aiModeSet = false;
  try {
    const { data, error } = await db
      .from("tenants")
      .select("display_name, legal_name, tier_id, seat_count, billing_period, status, ai_mode")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    if (!error && data) {
      const t = data as {
        display_name?: string | null;
        legal_name?: string | null;
        tier_id?: string | null;
        seat_count?: number | null;
        billing_period?: string | null;
        status?: string | null;
        ai_mode?: string | null;
      };
      workspaceName = t.display_name ?? t.legal_name ?? workspaceName;
      tenantTierId = t.tier_id ?? null;
      seatCount = t.seat_count ?? 1;
      billingPeriod = t.billing_period ?? null;
      tenantStatus = t.status ?? "active";
      aiModeSet = t.ai_mode != null && t.ai_mode !== "";
    }
  } catch {
    /* safe defaults retained */
  }

  // Owner first name — falls back to a friendly default for the greeting.
  let ownerFirstName = "there";
  if (userId) {
    try {
      const { data, error } = await db
        .from("users")
        .select("first_name")
        .eq("tenant_id", ctx.tenant_id)
        .eq("auth_user_id", userId)
        .maybeSingle();
      const fn = (data as { first_name?: string | null } | null)?.first_name;
      if (!error && fn) ownerFirstName = fn;
    } catch {
      /* keep default */
    }
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  const conversationsThisMonth = await countConversations(db, ctx.tenant_id, thisMonth);
  const conversationsPrevMonth = await countConversations(db, ctx.tenant_id, prevMonth);

  let aiMessagesThisMonth = 0;
  let chatLimitUsed = 0;
  let chatLimitCap = 0;
  try {
    const period = `[${thisMonth.start.slice(0, 10)},${thisMonth.end.slice(0, 10)})`;
    const { data, error } = await db
      .from("tenant_usage_metrics")
      .select("chat_messages_count")
      .eq("tenant_id", ctx.tenant_id)
      .eq("billing_period", period)
      .maybeSingle();
    const count = Number((data as { chat_messages_count?: number } | null)?.chat_messages_count ?? 0);
    if (!error) {
      aiMessagesThisMonth = count;
      chatLimitUsed = count;
    }
  } catch {
    /* defaults */
  }

  // Chat-limit cap: the tier's base monthly chat allowance (chat_base_monthly).
  // cap 0 means "no cap configured" and the UI hides the gauge.
  if (tenantTierId) {
    try {
      const { data, error } = await db
        .from("tier_definitions")
        .select("chat_base_monthly")
        .eq("id", tenantTierId)
        .maybeSingle();
      const cap = Number((data as { chat_base_monthly?: number } | null)?.chat_base_monthly ?? 0);
      if (!error && cap > 0) chatLimitCap = cap;
    } catch {
      /* no cap */
    }
  }

  let seatsInUse = 0;
  try {
    const { count, error } = await db
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenant_id)
      .eq("status", "active");
    if (!error) seatsInUse = count ?? 0;
  } catch {
    /* default 0 */
  }

  // ── Setup checklist ──────────────────────────────────────────────────────
  let hostConnected = false;
  try {
    const { data, error } = await db
      .from("tenant_host_configs")
      .select("id")
      .eq("tenant_id", ctx.tenant_id)
      .eq("is_active", true)
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) hostConnected = true;
  } catch {
    /* false */
  }

  let brandingSet = false;
  try {
    const { data, error } = await db
      .from("tenant_branding")
      .select("logo_url, primary_color")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const b = data as { logo_url?: string | null; primary_color?: string | null } | null;
    if (!error && b && (b.logo_url || b.primary_color)) brandingSet = true;
  } catch {
    /* false */
  }

  let personasCustomized = false;
  try {
    const { data, error } = await db
      .from("tenant_persona_overrides")
      .select("persona_slug")
      .eq("tenant_id", ctx.tenant_id)
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) personasCustomized = true;
  } catch {
    /* false */
  }

  // A team member has been "invited" once there's more than the founding owner.
  const teamMemberInvited = seatsInUse > 1;

  let emailTemplatesSet = false;
  try {
    const { data, error } = await db
      .from("tenant_email_templates")
      .select("email_type")
      .eq("tenant_id", ctx.tenant_id)
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) emailTemplatesSet = true;
  } catch {
    /* false */
  }

  // ── Recent activity ──────────────────────────────────────────────────────
  let activity: DashboardPayload["activity"] = [];
  try {
    const { data, error } = await db
      .from("audit_log")
      .select("id, action, occurred_at")
      .eq("tenant_id", ctx.tenant_id)
      .order("occurred_at", { ascending: false })
      .limit(10);
    if (!error && Array.isArray(data)) {
      activity = (data as Array<{ id: string; action: string; occurred_at: string }>).map((r) => ({
        id: r.id,
        action: r.action,
        description: describeAction(r.action),
        created_at: r.occurred_at,
      }));
    }
  } catch {
    /* empty */
  }

  // ── Plan ─────────────────────────────────────────────────────────────────
  let tierCode: string | null = null;
  let tierName: string | null = null;
  if (tenantTierId) {
    try {
      const { data, error } = await db
        .from("tier_definitions")
        .select("code, display_name")
        .eq("id", tenantTierId)
        .maybeSingle();
      const td = data as { code?: string | null; display_name?: string | null } | null;
      if (!error && td) {
        tierCode = td.code ?? null;
        tierName = td.display_name ?? null;
      }
    } catch {
      /* nulls */
    }
  }

  // Plan price (#1336/#1332): the tier's headline monthly price from the DB,
  // shown as "$X/mo". Period-aware — annual billing shows the monthly-equivalent
  // (annual / 12). Seat-ladder add-ons are NOT folded in; the card shows the
  // plan's list price, not the all-in invoice. Degrades to null on any failure.
  let priceMonthly: number | null = null;
  if (tierCode) {
    try {
      const pricing = await loadPricingTable(db);
      const tierBase = pricing.base[tierCode as keyof typeof pricing.base];
      if (tierBase) {
        priceMonthly = tierMonthlyPriceCents(tierBase, billingPeriod) / 100;
      }
    } catch {
      /* null — card shows "—" */
    }
  }

  const payload: DashboardPayload = {
    workspace: {
      name: workspaceName,
      owner_first_name: ownerFirstName,
      date: new Date().toISOString(),
    },
    stats: {
      conversations_this_month: conversationsThisMonth,
      conversations_prev_month: conversationsPrevMonth,
      ai_messages_this_month: aiMessagesThisMonth,
      chat_limit_used: chatLimitUsed,
      chat_limit_cap: chatLimitCap,
      chat_limit_reset_date: firstOfNextMonthISO(),
      seat_count: seatCount,
      seats_in_use: seatsInUse,
    },
    setup: {
      host_connected: hostConnected,
      branding_set: brandingSet,
      personas_customized: personasCustomized,
      team_member_invited: teamMemberInvited,
      email_templates_set: emailTemplatesSet,
      ai_mode_set: aiModeSet,
    },
    activity,
    plan: {
      tier_code: tierCode,
      tier_name: tierName,
      price_monthly: priceMonthly,
      billing_period: billingPeriod,
      status: tenantStatus,
    },
  };

  return Response.json(payload);
}
