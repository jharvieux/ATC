// §17.10 — Purges a user's data after the 30-day CCPA deletion grace period expires.
// Triggered by user.data_purge_scheduled when deleted_at + 30d elapses.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

interface PurgePayload {
  auth_user_id: string;
  user_id: string;
  deleted_at: string;
  purge_at: string;
}

async function purgeUserDataPerRetention(
  db: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  authUserId: string,
): Promise<void> {
  // TODO(part-6): full retention-compliant purge per §25.2.
  // Current stub: basic delete on core tables.

  // Anonymize bookings per §25.4 (null customer ref, store hash).
  // TODO(part-6): use actual email hash once users.email is available.
  await db.from("bookings")
    .update({ auth_user_id: null })
    .eq("auth_user_id", authUserId);

  // Delete conversation history.
  const { data: convs } = await db
    .from("conversations")
    .select("id")
    .eq("auth_user_id", authUserId);

  if (convs && convs.length > 0) {
    const convIds = (convs as { id: string }[]).map((c) => c.id);
    await db.from("messages").delete().in("conversation_id", convIds);
    await db.from("conversations").delete().eq("auth_user_id", authUserId);
  }

  // Delete consent records.
  await db.from("legal_consents").delete().eq("auth_user_id", authUserId);

  // Delete the users row itself.
  await db.from("users").delete().eq("id", userId);

  // TODO(part-6): audit_log entry for CCPA deletion completion.
  console.info("[user-data-purge] user=%s purge complete (stub)", userId);
}

export const userDataPurgeAfterGrace = inngest.createFunction(
  {
    id: "user-data-purge-after-grace",
    triggers: [{ event: "user.data_purge_scheduled" }],
  },
  async ({ event }) => {
    const { auth_user_id, user_id, deleted_at, purge_at } = event.data as PurgePayload;
    const db = createServiceRoleClient();

    // Wait until purge_at before executing.
    const purgeTime = new Date(purge_at).getTime();
    if (Date.now() < purgeTime) {
      // Rescheduled by the reconcile cron — return deferred.
      // TODO(inngest-delay): use inngest.sleep() when step functions are available.
      return { deferred: true, purge_at };
    }

    // Re-read the user row — if undo-delete was called, deleted_at will be NULL.
    const { data: userRow } = await db
      .from("users")
      .select("deleted_at")
      .eq("auth_user_id", auth_user_id)
      .maybeSingle();

    if (!userRow) {
      console.info("[user-data-purge] user=%s not found — already purged or undo succeeded", auth_user_id);
      return { skipped: true };
    }

    const typedUser = userRow as { deleted_at: string | null };
    if (!typedUser.deleted_at) {
      // User undid the deletion within the grace period.
      console.info("[user-data-purge] user=%s deletion was undone — skipping purge", auth_user_id);
      return { skipped: true, reason: "undo_delete" };
    }

    // Verify the deleted_at matches what we scheduled for (prevents re-delete after undo+re-delete).
    if (typedUser.deleted_at !== deleted_at) {
      console.info("[user-data-purge] user=%s deleted_at mismatch — skipping stale job", auth_user_id);
      return { skipped: true, reason: "stale" };
    }

    await purgeUserDataPerRetention(db, user_id, auth_user_id);
    return { ok: true };
  },
);
