// BP37 §37.5 — System task generator crons.
//
// Six daily generators per §37.5 (skipping the virus-scan one since
// virus scanning is deferred per 2026-05-23 user direction). Each cron
// scans for matching records, calls upsertSystemTask, and relies on
// the UNIQUE (tenant, origin, origin_reference) partial index to
// prevent duplicates across runs.
//
// All share the BP37_SYSTEM_TASK_GENERATORS_DISABLED kill-switch.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { upsertSystemTask, isoDaysFromNow } from "@/lib/tasks/system-task-helpers";

const KILL_SWITCH = "BP37_SYSTEM_TASK_GENERATORS_DISABLED";
const BATCH_LIMIT = 500;

function killed(): boolean {
  return process.env[KILL_SWITCH] === "true";
}

// ── 1. Passport expiring within 6 months of sailing date ──────────────
export const systemTaskPassportExpiring = inngest.createFunction(
  {
    id: "system-task-passport-expiring",
    triggers: [{ cron: "30 5 * * *" }], // daily 05:30 UTC
  },
  async () => {
    if (killed()) return { skipped: true, reason: KILL_SWITCH };
    const svc = createServiceRoleClient();

    const today = new Date();
    const sixMonthsOut = new Date(today.getTime() + 180 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // Future bookings where the primary contact's passport_expiry is
    // within 6 months of (today, sailing_date) — i.e., risk window applies.
    const { data, error } = await svc
      .from("bookings")
      .select("id, tenant_id, sailing_date, primary_contact_id, contacts:primary_contact_id(id, first_name, last_name, passport_expiry)")
      .gte("sailing_date", today.toISOString().slice(0, 10))
      .lte("sailing_date", sixMonthsOut)
      .in("status", ["confirmed", "submitted", "pending_host_review", "modified"])
      .limit(BATCH_LIMIT);
    if (error) return { error: error.message };

    type Row = {
      id: string;
      tenant_id: string;
      sailing_date: string;
      primary_contact_id: string | null;
      contacts: { id: string; first_name: string | null; last_name: string | null; passport_expiry: string | null } | { id: string; first_name: string | null; last_name: string | null; passport_expiry: string | null }[] | null;
    };

    let created = 0;
    for (const row of (data ?? []) as Row[]) {
      const c = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
      if (!c?.passport_expiry || !row.sailing_date) continue;
      // Passport expiry within 6 months of sailing date triggers.
      const expiryMs = Date.parse(c.passport_expiry);
      const sailMs = Date.parse(row.sailing_date);
      const sixMonthsMs = 180 * 24 * 60 * 60 * 1000;
      if (expiryMs > sailMs + sixMonthsMs) continue;

      const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "passenger";
      // Due 30 days from now OR 60 days before sailing, whichever sooner.
      const due30 = isoDaysFromNow(30);
      const due60BeforeSail = new Date(sailMs - 60 * 24 * 60 * 60 * 1000).toISOString();
      const due_at = Date.parse(due30) < Date.parse(due60BeforeSail) ? due30 : due60BeforeSail;

      const inserted = await upsertSystemTask(svc, {
        tenant_id: row.tenant_id,
        origin_reference: `passport_expiring:${row.id}`,
        title: `Confirm passport renewal with ${name}`,
        task_type: "document",
        priority: "high",
        due_at,
        booking_id: row.id,
        contact_id: c.id,
      });
      if (inserted) created++;
    }
    return { examined: data?.length ?? 0, created };
  },
);

// ── 2. Final payment due within 14 days ──────────────────────────────
// `final_payment_due_date` is not yet a column on bookings in the dev
// schema (BP15 deferred); using sailing_date - 90 days as a stand-in
// proxy per the cruise-industry convention.
export const systemTaskFinalPayment = inngest.createFunction(
  {
    id: "system-task-final-payment",
    triggers: [{ cron: "0 6 * * *" }], // daily 06:00 UTC
  },
  async () => {
    if (killed()) return { skipped: true, reason: KILL_SWITCH };
    const svc = createServiceRoleClient();

    const today = new Date();
    // Final payment is typically due 90 days before sailing. We surface
    // a reminder 14 days before the final payment date — i.e., between
    // 90 and 104 days before sailing.
    const windowStart = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const windowEnd = new Date(today.getTime() + 104 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data, error } = await svc
      .from("bookings")
      .select("id, tenant_id, cruise_line, sailing_date, primary_contact_id, contacts:primary_contact_id(id, first_name, last_name)")
      .gte("sailing_date", windowStart)
      .lte("sailing_date", windowEnd)
      .in("status", ["confirmed", "submitted", "pending_host_review", "modified"])
      .limit(BATCH_LIMIT);
    if (error) return { error: error.message };

    type Row = {
      id: string;
      tenant_id: string;
      cruise_line: string | null;
      sailing_date: string;
      contacts: { id: string; first_name: string | null; last_name: string | null } | { id: string; first_name: string | null; last_name: string | null }[] | null;
    };

    let created = 0;
    for (const row of (data ?? []) as Row[]) {
      const c = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
      const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ") || "the customer" : "the customer";
      const sailMs = Date.parse(row.sailing_date);
      const finalDueMs = sailMs - 90 * 24 * 60 * 60 * 1000;
      const due_at = new Date(finalDueMs - 7 * 24 * 60 * 60 * 1000).toISOString();

      const inserted = await upsertSystemTask(svc, {
        tenant_id: row.tenant_id,
        origin_reference: `final_payment:${row.id}`,
        title: `Remind ${name} about final payment for ${row.cruise_line ?? "cruise"}`,
        task_type: "call",
        priority: "high",
        due_at,
        booking_id: row.id,
        contact_id: c?.id ?? null,
      });
      if (inserted) created++;
    }
    return { examined: data?.length ?? 0, created };
  },
);

// ── 3. Quote about to expire (within 48 hours) ───────────────────────
export const systemTaskQuoteExpiring = inngest.createFunction(
  {
    id: "system-task-quote-expiring",
    triggers: [{ cron: "0 7 * * *" }], // daily 07:00 UTC
  },
  async () => {
    if (killed()) return { skipped: true, reason: KILL_SWITCH };
    const svc = createServiceRoleClient();

    const now = new Date();
    const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

    const { data, error } = await svc
      .from("quotes")
      .select("id, tenant_id, contact_id, valid_until, contacts:contact_id(first_name, last_name)")
      .in("status", ["sent", "viewed"])
      .not("valid_until", "is", null)
      .gte("valid_until", now.toISOString())
      .lte("valid_until", in48h)
      .limit(BATCH_LIMIT);
    if (error) return { error: error.message };

    type Row = {
      id: string;
      tenant_id: string;
      contact_id: string | null;
      valid_until: string;
      contacts: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
    };

    let created = 0;
    for (const row of (data ?? []) as Row[]) {
      const c = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
      const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ") || "the customer" : "the customer";
      const due_at = new Date(Date.parse(row.valid_until) - 24 * 60 * 60 * 1000).toISOString();
      const inserted = await upsertSystemTask(svc, {
        tenant_id: row.tenant_id,
        origin_reference: `quote_expiring:${row.id}`,
        title: `Quote expiring soon — follow up with ${name}`,
        task_type: "follow_up",
        priority: "high",
        due_at,
        quote_id: row.id,
        contact_id: row.contact_id,
      });
      if (inserted) created++;
    }
    return { examined: data?.length ?? 0, created };
  },
);

// ── 4. Booking sailed without post-trip task ─────────────────────────
export const systemTaskPostTrip = inngest.createFunction(
  {
    id: "system-task-post-trip",
    triggers: [{ cron: "30 6 * * *" }], // daily 06:30 UTC
  },
  async () => {
    if (killed()) return { skipped: true, reason: KILL_SWITCH };
    const svc = createServiceRoleClient();

    const today = new Date();
    // Look at bookings whose return_date (or sailing_date as fallback) was
    // 3+ days ago and ≤ 14 days ago. Limits the daily scan window.
    const windowStart = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const windowEnd = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data, error } = await svc
      .from("bookings")
      .select("id, tenant_id, cruise_line, return_date, sailing_date, primary_contact_id, contacts:primary_contact_id(id, first_name, last_name)")
      .in("status", ["sailed", "completed", "confirmed"])
      .gte("return_date", windowStart)
      .lte("return_date", windowEnd)
      .limit(BATCH_LIMIT);
    if (error) return { error: error.message };

    type Row = {
      id: string;
      tenant_id: string;
      cruise_line: string | null;
      return_date: string | null;
      sailing_date: string | null;
      primary_contact_id: string | null;
      contacts: { id: string; first_name: string | null; last_name: string | null } | { id: string; first_name: string | null; last_name: string | null }[] | null;
    };

    let created = 0;
    for (const row of (data ?? []) as Row[]) {
      const c = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
      const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ") || "the customer" : "the customer";
      const inserted = await upsertSystemTask(svc, {
        tenant_id: row.tenant_id,
        origin_reference: `post_trip:${row.id}`,
        title: `Post-trip check-in with ${name}`,
        task_type: "follow_up",
        priority: "normal",
        due_at: isoDaysFromNow(0),
        booking_id: row.id,
        contact_id: c?.id ?? null,
      });
      if (inserted) created++;
    }
    return { examined: data?.length ?? 0, created };
  },
);

// ── 5. Lead aging — Lead stage > 30 days without activity ────────────
export const systemTaskLeadAging = inngest.createFunction(
  {
    id: "system-task-lead-aging",
    triggers: [{ cron: "0 8 * * *" }], // daily 08:00 UTC
  },
  async () => {
    if (killed()) return { skipped: true, reason: KILL_SWITCH };
    const svc = createServiceRoleClient();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await svc
      .from("contacts")
      .select("id, tenant_id, first_name, last_name, pipeline_stage_key, updated_at")
      .eq("pipeline_stage_key", "lead")
      .lte("updated_at", thirtyDaysAgo)
      .limit(BATCH_LIMIT);
    if (error) return { error: error.message };

    type Row = {
      id: string;
      tenant_id: string;
      first_name: string | null;
      last_name: string | null;
    };

    let created = 0;
    for (const row of (data ?? []) as Row[]) {
      const name = [row.first_name, row.last_name].filter(Boolean).join(" ") || "the lead";
      const inserted = await upsertSystemTask(svc, {
        tenant_id: row.tenant_id,
        origin_reference: `lead_aging:${row.id}`,
        title: `Lead aging — re-engage ${name} or mark cold`,
        task_type: "follow_up",
        priority: "normal",
        due_at: isoDaysFromNow(0),
        contact_id: row.id,
      });
      if (inserted) created++;
    }
    return { examined: data?.length ?? 0, created };
  },
);

// ── 6. Imported booking pending commission rate (§34.7.3 step 3) ─────
// Surfaces in the agent's task list when the import promoter falls
// through to "agent rate needed" — independent reminder so it doesn't
// only live in the review queue.
export const systemTaskCommissionRateMissing = inngest.createFunction(
  {
    id: "system-task-commission-rate-missing",
    triggers: [{ cron: "15 7 * * *" }], // daily 07:15 UTC
  },
  async () => {
    if (killed()) return { skipped: true, reason: KILL_SWITCH };
    const svc = createServiceRoleClient();

    // Depends on BP34 import_queue table (#133). Soft-fail if not present
    // so this cron co-exists with environments where BP34 hasn't shipped.
    const { data, error } = await svc
      .from("import_queue")
      .select("id, tenant_id, source_ref")
      .eq("status", "pending_review")
      .eq("parse_failure_reason", "commission_rate_missing")
      .limit(BATCH_LIMIT);
    if (error) {
      if (error.code === "42P01") {
        return { skipped: true, reason: "import_queue_table_absent" };
      }
      return { error: error.message };
    }

    type Row = { id: string; tenant_id: string; source_ref: string };
    let created = 0;
    for (const row of (data ?? []) as Row[]) {
      const inserted = await upsertSystemTask(svc, {
        tenant_id: row.tenant_id,
        origin_reference: `commission_rate_missing:${row.id}`,
        title: `Set commission rate for imported booking (${row.source_ref.slice(0, 40)})`,
        task_type: "review",
        priority: "high",
        due_at: isoDaysFromNow(0),
        contact_id: null, // not yet linked to a contact (pre-promotion)
      });
      if (inserted) created++;
    }
    return { examined: data?.length ?? 0, created };
  },
);
