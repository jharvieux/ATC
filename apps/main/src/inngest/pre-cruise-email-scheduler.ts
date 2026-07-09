// §23.4 — Pre-cruise email scheduler.
//
// Split into two functions per the §27.12 batch migration:
//
//   T-1 (24h before sailing) STAYS hourly and stays DIRECT (no batch).
//     Why: the customer expects "your cruise is tomorrow" to land at
//     about the right hour. A 24h batch SLA could put the email
//     anywhere from on-time to landing AT sailing.
//
//   T-7 / T-30 / T-90 move to a DAILY cron and the generate-and-send
//     step is BATCHED via the §27.12 ai_batch_requests pipeline. Anthropic
//     processes batches within an hour in practice — well inside the
//     "about a week" / "about a month" / "about three months" precision
//     these phases actually need. ~50% Haiku cost reduction on
//     pre-cruise generation as a result.
//
// Both schedulers emit the same precruise/email.due event with one extra
// field: `via: "direct" | "batched"`. The consumer
// (precruise-generate-and-send) routes by that field.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

type Phase = "t_90" | "t_30" | "t_7" | "t_1";

const ALL_PHASES: Array<{ phase: Phase; envKey: string; defaultHours: number }> = [
  { phase: "t_90", envKey: "PRECRUISE_T90_HOURS_BEFORE", defaultHours: 2160 },
  { phase: "t_30", envKey: "PRECRUISE_T30_HOURS_BEFORE", defaultHours: 720 },
  { phase: "t_7",  envKey: "PRECRUISE_T7_HOURS_BEFORE",  defaultHours: 168 },
  { phase: "t_1",  envKey: "PRECRUISE_T1_HOURS_BEFORE",  defaultHours: 24 },
];

const T1_ONLY = ALL_PHASES.filter((p) => p.phase === "t_1");
const MULTIPHASE = ALL_PHASES.filter((p) => p.phase !== "t_1");

interface BookingRow {
  id: string;
  tenant_id: string;
  group_booking_id: string;
  groups: Array<{ sailing_date: string }> | { sailing_date: string } | null;
}

/**
 * Shared inner loop: for the given phase set, find bookings whose
 * sailing_date - now is within ±windowHours of the target hours and
 * for which no pre_cruise_email_content row exists yet, then fire
 * precruise/email.due with the supplied `via` discriminator.
 *
 * windowHours: ±1 for hourly (T-1), ±12 for daily (T-7/T-30/T-90).
 */
async function scanAndEmit(args: {
  via: "direct" | "batched";
  phases: typeof ALL_PHASES;
  windowHours: number;
}): Promise<{ triggered: number }> {
  const { via, phases, windowHours } = args;
  const svc = createServiceRoleClient();
  const nowMs = Date.now();

  // D-091 Pattern 4: this scheduler is DELIBERATELY cross-tenant — it scans all
  // confirmed group bookings platform-wide and fans out per booking, carrying
  // booking.tenant_id into each downstream send. A tenant_id filter here would
  // defeat the scheduler's purpose; tenant scoping happens at the per-send step.
  //
  // #1745 — PostgREST caps any single response at ~1000 rows (db-max-rows)
  // regardless of a requested .limit(), which would silently drop some
  // confirmed group bookings from the fan-out (those customers would never
  // get a pre-cruise email). Page in 1000-row windows (matches
  // apps/rag/src/lib/embeddings/batch/flush.ts, #808) so every confirmed
  // group booking is scanned.
  const PAGE = 1000;
  const bookings: BookingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await svc
      .from("bookings")
      // #1190: the FK column is group_booking_id, not group_id.
      .select("id, tenant_id, group_booking_id, groups(sailing_date)")
      .eq("status", "confirmed")
      .not("group_booking_id", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[pre-cruise-scheduler:${via}] query error`, error.message);
      return { triggered: 0 };
    }
    const batch = (page ?? []) as BookingRow[];
    bookings.push(...batch);
    if (batch.length < PAGE) break;
  }

  let triggered = 0;
  for (const booking of bookings) {
    const groupsRaw = booking.groups;
    const groupRow = Array.isArray(groupsRaw) ? groupsRaw[0] : groupsRaw;
    const sailingDateStr = groupRow?.sailing_date;
    if (!sailingDateStr) continue;

    const sailingMs = new Date(sailingDateStr).getTime();
    const hoursBefore = (sailingMs - nowMs) / (1000 * 60 * 60);

    for (const { phase, envKey, defaultHours } of phases) {
      const targetHours = Number(process.env[envKey] ?? defaultHours);
      const diff = Math.abs(hoursBefore - targetHours);
      if (diff > windowHours) continue;

      // #1582: dedup on sent_at, not row existence. A row can exist with
      // sent_at null after a send that failed all its Inngest retries (e.g.
      // a sustained Resend outage or a misconfigured tenant key) — skipping
      // on existence alone would silently drop that booking's email forever.
      const { data: existingRaw } = await svc
        .from("pre_cruise_email_content")
        .select("id, sent_at")
        .eq("booking_id", booking.id)
        .eq("email_phase", phase)
        .maybeSingle();
      const existing = existingRaw as { id: string; sent_at?: string | null } | null;
      if (existing?.sent_at) continue;

      await inngest.send({
        name: "precruise/email.due",
        data: {
          booking_id: booking.id,
          tenant_id: booking.tenant_id,
          phase,
          via,
        },
      });
      triggered++;
    }
  }

  console.log(`[pre-cruise-scheduler:${via}] triggered=${triggered}`);
  return { triggered };
}

// ── T-1: hourly, direct (preserve current behavior for the time-
// sensitive 24-hours-before email).
export const preCruiseEmailSchedulerT1 = inngest.createFunction(
  { id: "pre-cruise-email-scheduler-t1", triggers: [{ cron: "0 * * * *" }] },
  async () => scanAndEmit({ via: "direct", phases: T1_ONLY, windowHours: 1 }),
);

// ── T-7 / T-30 / T-90: daily 9:00 UTC, batched.
// Daily cadence + ±12h window ensures every booking that hits a phase
// during the day gets caught exactly once. ±12h is appropriate since
// the batched email lands within ~1h of the batch flush (9:30 UTC),
// which is well inside customer precision tolerance for "about a week"
// or "about a month" out.
export const preCruiseEmailSchedulerMultiphase = inngest.createFunction(
  { id: "pre-cruise-email-scheduler-multiphase", triggers: [{ cron: "0 9 * * *" }] },
  async () => scanAndEmit({ via: "batched", phases: MULTIPHASE, windowHours: 12 }),
);

// Backward-compat alias for the legacy export name. The Inngest registry
// (route.ts) registers the two new functions instead; this stays so any
// in-flight imports keep typechecking. Delete once we've verified no
// stale references in CI.
export const preCruiseEmailScheduler = preCruiseEmailSchedulerT1;
