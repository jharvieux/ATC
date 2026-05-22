// §11.5 — Nightly cron: flag customer_memories rows where an estimated DOB
// is overdue for re-confirmation.
//
// Sets awaiting_dob_reprompt = true on affected rows. The persona clears
// this flag and sets estimation_last_reprompt_at after actually issuing
// the re-prompt at chat time (buildSystemPrompt, Prompt 10).
//
// Selection criteria per §11.5:
//   - At least one family_composition entry has date_of_birth_is_estimated = true
//   - The associated user has sent a message in the last 90 days (still active)
//   - The estimated entry is overdue per isEstimatedDOBOverdue (>365 days since
//     recorded AND >365 days since last_reprompt, or never re-prompted)
//
// The JSONB path query runs inside Postgres to avoid loading all rows.
// Idempotent: rows already flagged are skipped by the UPDATE condition.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "./client";
import { isEstimatedDOBOverdue, type FamilyMember } from "@/lib/memory/dob";

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

    // Filter: user must have been active in the last 90 days.
    const activeUserIds = await getActiveUserIds(db, activeWindowCutoff);

    let flaggedCount = 0;

    for (const row of candidates) {
      if (!activeUserIds.has(row.user_id as string)) continue;

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

    return { status: "ok", flagged: flaggedCount };
  },
);

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
