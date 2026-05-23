// §17.10 / §25.4a — Purges a user's data after the 30-day CCPA deletion grace
// period expires. Triggered by user.data_purge_scheduled.
//
// BP25 finalization: the inline stub is replaced with a call to
// lib/privacy/purge-user-data which implements the §25.4a three-category
// anonymization, forensics-snapshot-before-deletion for active disputes,
// and the audit row insert.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { purgeUserDataPerRetention } from "@/lib/privacy/purge-user-data";
import { createNotification } from "@/lib/notifications/create";

interface PurgePayload {
  auth_user_id: string;
  user_id: string;
  deleted_at: string;
  purge_at: string;
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
      .select("deleted_at, status")
      .eq("auth_user_id", auth_user_id)
      .maybeSingle();

    if (!userRow) {
      console.info("[user-data-purge] user=%s not found — already purged or undo succeeded", auth_user_id);
      return { skipped: true };
    }

    const typedUser = userRow as { deleted_at: string | null; status: string };
    if (!typedUser.deleted_at) {
      console.info("[user-data-purge] user=%s deletion was undone — skipping purge", auth_user_id);
      return { skipped: true, reason: "undo_delete" };
    }
    if (typedUser.deleted_at !== deleted_at) {
      console.info("[user-data-purge] user=%s deleted_at mismatch — skipping stale job", auth_user_id);
      return { skipped: true, reason: "stale" };
    }
    if (typedUser.status === "purged") {
      console.info("[user-data-purge] user=%s already purged — skipping", auth_user_id);
      return { skipped: true, reason: "already_purged" };
    }

    const result = await purgeUserDataPerRetention(db, {
      user_id,
      grace_period_ended_at: deleted_at,
    });

    if (result.purge_outcome === "error") {
      // Leave users.status='deleted' so a future retry can pick this up.
      console.warn(
        "[user-data-purge] user=%s purge FAILED detail=%s",
        user_id,
        result.error_detail,
      );
      return { ok: false, error: result.error_detail, counts: result.counts };
    }

    // §25.4a Category 3 — notify the affected tenants' admins so they can
    // review residual PII in their CRM notes. No formal tenant_admin role
    // exists today (§26 ships RBAC); for now we notify every active user
    // in each affected tenant — operators can narrow later.
    // TODO(rbac-tenant-admin): target only tenant_admin once roles ship.
    for (const tenantId of result.affected_tenant_ids) {
      const { data: users } = await db
        .from("users")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("status", "active");
      for (const u of ((users ?? []) as Array<{ id: string }>)) {
        await createNotification({
          db,
          tenant_id: tenantId,
          user_id: u.id,
          category: "system",
          title: "Customer removed under CCPA — review your notes for residual PII",
          body: "A customer exercised CCPA deletion. Notes you wrote about them are retained but their identifier was anonymized. Review and redact any PII in the note text.",
          link_url: "/tenant-admin/crm/anonymized-notes",
        });
      }
    }

    return {
      ok: true,
      counts: result.counts,
      forensics_snapshot_id: result.forensics_snapshot_id,
      affected_tenant_ids: result.affected_tenant_ids,
    };
  },
);
