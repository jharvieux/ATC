// §17.10 / §25.4a — Purges a user's data after the 30-day CCPA deletion grace
// period expires. Triggered by user.data_purge_scheduled.
//
// BP25 finalization: the inline stub is replaced with a call to
// lib/privacy/purge-user-data which implements the §25.4a three-category
// anonymization, forensics-snapshot-before-deletion for active disputes,
// and the audit row insert.

import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { purgeUserDataPerRetention } from "@/lib/privacy/purge-user-data";
import { createNotification } from "@/lib/notifications/create";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — each active user's in-app notification is an independent insert.
const NOTIFY_CONCURRENCY = 20;

// #742: validate the event payload with Zod so a crafted event (compromised
// signing key) cannot skip the 30-day grace period by providing a past purge_at.
const PurgePayloadSchema = z.object({
  auth_user_id: z.string().uuid(),
  user_id: z.string().uuid(),
  deleted_at: z.string().datetime(),
  purge_at: z.string().datetime(),
}).refine(
  (d) => new Date(d.purge_at).getTime() >= new Date(d.deleted_at).getTime() + 25 * 24 * 60 * 60 * 1000,
  { message: "purge_at must be at least 25 days after deleted_at" },
);

export const userDataPurgeAfterGrace = inngest.createFunction(
  {
    id: "user-data-purge-after-grace",
    triggers: [{ event: "user.data_purge_scheduled" }],
  },
  async ({ event, step }) => {
    const parsed = PurgePayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[user-data-purge] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const { auth_user_id, user_id, deleted_at, purge_at } = parsed.data;

    // §17.10 — Sleep until purge_at (30 days after the delete request).
    // Inngest persists the function state during sleep; on wake we
    // re-check user state to handle undo-delete cleanly.
    await step.sleepUntil("ccpa-grace-period", purge_at);

    const db = createServiceRoleClient();

    // Re-read the user row by PK (D-091 Round-3 #45 fix). The prior version
    // filtered by `auth_user_id` and called `maybeSingle()`, which silently
    // returned null when the auth user existed in multiple tenants (each
    // tenant has its own users row keyed by (tenant_id, auth_user_id)).
    // Multi-tenant users could never be purged because the re-read always
    // hit the multi-row case and bailed.
    //
    // The event payload's `user_id` is the PK of the specific tenant-scoped
    // users row this purge run is for, so filtering on that is unambiguous.
    const { data: userRow } = await db
      .from("users")
      .select("deleted_at, status")
      .eq("id", user_id)
      .maybeSingle();

    if (!userRow) {
      console.info(
        "[user-data-purge] user_id=%s auth_user=%s not found — already purged or undo succeeded",
        user_id,
        auth_user_id,
      );
      return { skipped: true };
    }

    const typedUser = userRow as { deleted_at: string | null; status: string };
    if (!typedUser.deleted_at) {
      console.info(
        "[user-data-purge] user_id=%s auth_user=%s deletion was undone — skipping purge",
        user_id,
        auth_user_id,
      );
      return { skipped: true, reason: "undo_delete" };
    }
    if (typedUser.deleted_at !== deleted_at) {
      console.info(
        "[user-data-purge] user_id=%s auth_user=%s deleted_at mismatch — skipping stale job",
        user_id,
        auth_user_id,
      );
      return { skipped: true, reason: "stale" };
    }
    if (typedUser.status === "purged") {
      console.info(
        "[user-data-purge] user_id=%s auth_user=%s already purged — skipping",
        user_id,
        auth_user_id,
      );
      return { skipped: true, reason: "already_purged" };
    }

    // #742: use the DB-sourced deleted_at, not the event payload value, so a
    // crafted event with a different timestamp cannot widen the grace window.
    const result = await purgeUserDataPerRetention(db, {
      user_id,
      grace_period_ended_at: typedUser.deleted_at,
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
    // createNotification throws (safeAwaitRequired). Letting that reject out of
    // mapWithConcurrency's Promise.all would abandon up to NOTIFY_CONCURRENCY-1
    // in-flight inserts mid-run, and `notifications` has no unique constraint
    // for this shape — so Inngest's retry duplicates whatever landed.
    // TODO(notifications-dedup): a UNIQUE(tenant_id,user_id,category,title)
    // index + 23505 swallow is the durable fix (needs a migration);
    // collect-and-throw-once bounds the damage until then.
    const notifyFailures: Array<{ tenant_id: string; user_id: string; error: string }> = [];
    for (const tenantId of result.affected_tenant_ids) {
      const { data: users } = await db
        .from("users")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("status", "active");
      await mapWithConcurrency((users ?? []) as Array<{ id: string }>, NOTIFY_CONCURRENCY, async (u) => {
        try {
          await createNotification({
            db,
            tenant_id: tenantId,
            user_id: u.id,
            category: "system",
            title: "Customer removed under CCPA — review your notes for residual PII",
            body: "A customer exercised CCPA deletion. Notes you wrote about them are retained but their identifier was anonymized. Review and redact any PII in the note text.",
            link_url: "/tenant-admin/crm/anonymized-notes",
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(
            "[user-data-purge] notification failed tenant=%s user=%s: %s",
            tenantId,
            u.id,
            message,
          );
          notifyFailures.push({ tenant_id: tenantId, user_id: u.id, error: message });
        }
      });
    }

    // Fail loud so Inngest retries — but only AFTER every tenant's admins were
    // attempted, so one bad row can't starve the rest of the notifications.
    if (notifyFailures.length > 0) {
      throw new Error(
        `[user-data-purge] ${notifyFailures.length} notification(s) failed: ${JSON.stringify(notifyFailures)}`,
      );
    }

    return {
      ok: true,
      counts: result.counts,
      forensics_snapshot_id: result.forensics_snapshot_id,
      affected_tenant_ids: result.affected_tenant_ids,
    };
  },
);
