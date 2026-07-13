// §11.5 — Nightly cron: flag customer_memories rows where an estimated DOB
// is overdue for re-confirmation.
//
// Sets awaiting_dob_reprompt = true on affected rows. The persona clears
// this flag and sets estimation_last_reprompt_at after actually issuing
// the re-prompt at chat time (buildSystemPrompt, Prompt 10).
//
// Selection criteria per §11.5 (operator-tightened per MEMORY D-087):
//   - At least one family_composition entry has date_of_birth_is_estimated = true
//   - The associated user has sent a message in the last 90 days (still active)
//   - The estimated entry is overdue per isEstimatedDOBOverdue
//     (>DOB_REPROMPT_INTERVAL_DAYS since recorded AND since last_reprompt,
//      default 30 days)
//   - The user does NOT have a booking with sailing_date within the next
//     DOB_IMMINENT_BOOKING_WINDOW_DAYS (default 60). Imminent-booking users
//     hit the §20.5 submit gate, which surfaces the estimated DOB directly
//     to the customer — chat re-prompting would be redundant.
//
// Idempotent: rows already flagged are skipped by the UPDATE condition.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "./client";
import {
  isEstimatedDOBOverdue,
  imminentBookingWindowMs,
  type FamilyMember,
} from "@/lib/memory/dob";

const ACTIVE_WINDOW_DAYS = 90;

export const dobEstimateRepromptEligible = inngest.createFunction(
  {
    id: "dob-estimate-reprompt-eligible",
    triggers: [{ cron: "0 5 * * *" }],
  },
  async () => {
    // Service-role required: scans customer_memories cross-tenant (cron, no user session).
    // This file is in the no-direct-service-role-import allowlist.
    const db = createServiceRoleClient();
    const now = new Date();
    const activeWindowCutoff = new Date(
      now.getTime() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Find customer_memories rows that:
    //   1. Have at least one estimated DOB entry in family_composition
    //   2. The associated user has a message within the last 90 days
    //   3. Not already flagged (awaiting_dob_reprompt = false)
    //
    // jsonb_path_exists checks for any family member entry with
    // date_of_birth_is_estimated == true.
    const { data: candidates, error } = await db
      .from("customer_memories")
      .select(
        "id, user_id, tenant_id, family_composition, awaiting_dob_reprompt",
      )
      .eq("awaiting_dob_reprompt", false)
      .not("family_composition", "is", null);

    if (error) {
      console.error("[dob-reprompt-cron] fetch error", { error });
      return { status: "error", message: error.message };
    }

    if (!candidates || candidates.length === 0) {
      return { status: "ok", flagged: 0 };
    }

    // #1792 — both filters are independent reads (neither depends on the
    // other); fan out instead of waiting on them in sequence.
    const [activeUserIds, usersWithImminentBookings] = await Promise.all([
      // Filter: user must have been active in the last 90 days.
      getActiveUserIds(db, activeWindowCutoff),
      // §11.5 D-087 — Filter: user must NOT have an active booking with
      // sailing_date inside the imminent-booking window. The §20.5 submit
      // gate handles those; chat re-prompting would be redundant noise.
      getUsersWithImminentBookings(db),
    ]);

    let flaggedCount = 0;
    let skippedImminent = 0;

    for (const row of candidates) {
      const userId = row.user_id as string;
      if (!activeUserIds.has(userId)) continue;
      if (usersWithImminentBookings.has(userId)) {
        skippedImminent += 1;
        continue;
      }

      const family = row.family_composition as FamilyMember[] | null;
      if (!Array.isArray(family)) continue;

      const hasOverdue = family.some((member) => isEstimatedDOBOverdue(member));
      if (!hasOverdue) continue;

      const { error: updateErr } = await db
        .from("customer_memories")
        .update({ awaiting_dob_reprompt: true })
        .eq("id", row.id)
        .eq("awaiting_dob_reprompt", false); // idempotency guard

      if (updateErr) {
        console.error("[dob-reprompt-cron] update error", {
          id: row.id,
          error: updateErr,
        });
        continue;
      }
      flaggedCount++;
    }

    return { status: "ok", flagged: flaggedCount, skipped_imminent: skippedImminent };
  },
);

async function getUsersWithImminentBookings(
  db: ReturnType<typeof createServiceRoleClient>,
): Promise<Set<string>> {
  // Imminent = sailing_date is between today and now + window. Past
  // sailings don't count.
  const now = Date.now();
  const windowEndIso = new Date(now + imminentBookingWindowMs()).toISOString().slice(0, 10);
  const todayIso = new Date(now).toISOString().slice(0, 10);

  // bookings are tenant-scoped but the cron runs cross-tenant via service
  // role. We're not leaking any user data — just collecting user_ids that
  // appear on imminent bookings. Bookings link to contacts; contacts can
  // be tied to a user_id via owning_user_id on the customer_memories row,
  // but the canonical user→booking link runs through bookings.user_id when
  // populated, otherwise via the primary contact's owner.
  //
  // Safe approximation for the cron: query bookings whose sailing_date is
  // in [today, today + window] and whose user_id is set.
  //
  // #1745 — PostgREST caps any single response at ~1000 rows (db-max-rows)
  // regardless of a requested .limit(), which would silently drop some
  // imminent-booking users from this set — those users would then wrongly
  // stay eligible for a DOB re-prompt the §20.5 submit gate already covers.
  // Page in 1000-row windows (matches apps/rag/src/lib/embeddings/batch/
  // flush.ts, #808) so every imminent booking is scanned.
  const PAGE = 1000;
  const userIds: Array<string | null> = [];
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await db
      .from("bookings")
      .select("user_id")
      .gte("sailing_date", todayIso)
      .lte("sailing_date", windowEndIso)
      .not("user_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[dob-reprompt-cron] imminent bookings fetch error", { error });
      return new Set();
    }
    const batch = (page ?? []) as Array<{ user_id: string | null }>;
    userIds.push(...batch.map((r) => r.user_id));
    if (batch.length < PAGE) break;
  }
  return new Set(userIds.filter(Boolean) as string[]);
}

async function getActiveUserIds(
  db: ReturnType<typeof createServiceRoleClient>,
  since: string,
): Promise<Set<string>> {
  const { data, error } = await db
    .from("messages")
    .select("user_id")
    .eq("role", "user")
    .gte("created_at", since)
    .not("user_id", "is", null);

  if (error) {
    console.error("[dob-reprompt-cron] active users fetch error", { error });
    return new Set();
  }

  return new Set(
    (data ?? [])
      .map((r: { user_id: string | null }) => r.user_id)
      .filter(Boolean) as string[],
  );
}
