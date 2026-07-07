// BP37 §37.3 — Reminder fire-up cron core logic.
// Runs every minute via Vercel cron (/api/cron/task-reminders-fire).
// Sweeps task_reminders WHERE remind_at <= NOW AND fired_at IS NULL.
// For 'in_app' reminders, stamps fired. For 'email', sends via Resend.
// Snoozed tasks suppress their reminders (§37.3.3).
//
// #1581: overlapping runs (a batch that overruns the 1-min cron interval)
// used to double-send, because rows were only stamped AFTER sending, with
// no claim step in between. Each row is now CAS-claimed via `sending_at`
// before send — mirrors `tryAcquirePayoutLock` (payouts-execute-transfer.ts).
//
// Service-role import permitted: background cron, no user session. §5.4.4.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendTaskReminderEmail } from "@/lib/tasks/send-reminder-email";
import { safeAwait } from "@/lib/db/safe-mutation";

const BATCH_LIMIT = 200;
// Drain loop budget — stop fetching new batches after 50s to leave
// headroom before the 1-min cron re-fires. (#900)
const TIME_BUDGET_MS = 50_000;
// #1581 — a claim (`sending_at`) older than this means the claiming run
// crashed before finalizing the row; safe to reclaim and retry.
const CLAIM_STALE_MS = 5 * 60_000;

type Row = {
  id: string;
  tenant_id: string;
  task_id: string;
  channel: "in_app" | "email";
  remind_at: string;
  tasks:
    | { snoozed_until: string | null; assigned_to_user_id: string | null; status: string; title: string }
    | { snoozed_until: string | null; assigned_to_user_id: string | null; status: string; title: string }[]
    | null;
};

/**
 * #1581 — CAS row claim, mirroring `tryAcquirePayoutLock`. Stamps
 * `sending_at` guarded by "unclaimed OR stale claim", so a concurrent
 * cron run (or a crashed prior run) can't cause a double-send. Returns
 * false if another run already holds a fresh claim.
 */
export async function tryClaimReminderRow(
  svc: ReturnType<typeof createServiceRoleClient>,
  id: string,
  nowIso: string,
): Promise<boolean> {
  const staleCutoffIso = new Date(Date.parse(nowIso) - CLAIM_STALE_MS).toISOString();
  const { data, error } = await svc
    .from("task_reminders")
    .update({ sending_at: nowIso })
    .eq("id", id)
    .is("fired_at", null)
    .or(`sending_at.is.null,sending_at.lt.${staleCutoffIso}`)
    .select("id");
  if (error) {
    console.error(`[task-reminders-fire] claim failed for ${id}:`, error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

export async function runTaskRemindersFire() {
  if (process.env.BP37_REMINDERS_DISABLED === "true") {
    return { skipped: true, reason: "BP37_REMINDERS_DISABLED=true" };
  }

  const svc = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  let processed = 0;
  let delivered = 0;
  let suppressed = 0;
  let failed = 0;
  let batches = 0;
  const start = Date.now();

  const staleCutoffIso = new Date(Date.parse(nowIso) - CLAIM_STALE_MS).toISOString();

  // #900: drain loop — keep fetching batches until the backlog is empty
  // or the time budget is exhausted. fired_at IS NULL makes re-fetching
  // safe: each pass only sees rows not yet stamped by this or a prior run.
  // #1581: also skip rows another (still-fresh) run has claimed.
  while (Date.now() - start < TIME_BUDGET_MS) {
    const { data, error } = await svc
      .from("task_reminders")
      .select("id, tenant_id, task_id, channel, remind_at, tasks!inner(snoozed_until, assigned_to_user_id, status, title)")
      .is("fired_at", null)
      .or(`sending_at.is.null,sending_at.lt.${staleCutoffIso}`)
      .lte("remind_at", nowIso)
      .limit(BATCH_LIMIT);
    if (error) throw new Error(`task_reminders select failed: ${error.message}`);

    const rows = (data ?? []) as Row[];
    batches++;

    for (const r of rows) {
      // #1581 — claim before send. 0 rows means a concurrent (still-fresh)
      // run already holds this row; skip it rather than double-sending.
      const claimed = await tryClaimReminderRow(svc, r.id, new Date().toISOString());
      if (!claimed) {
        processed++; // count skipped rows so processed = rows.length always (no contention metric)
        continue;
      }

      const t = Array.isArray(r.tasks) ? r.tasks[0] ?? null : r.tasks;
      // §37.3.3 — suppress reminders that fall inside a snooze window.
      const snoozed = t?.snoozed_until && Date.parse(r.remind_at) < Date.parse(t.snoozed_until);

      let status: "delivered" | "suppressed" | "failed";
      try {
        // Determine status *without* external dispatch or DB writes — if any error
        // here, it's safe to release the claim immediately for quick retry.
        if (snoozed) {
          status = "suppressed";
        } else if (r.channel === "email") {
          // §37.3.2 — send through BP23 email infrastructure. sendTaskReminderEmail
          // never throws; every failure (suppressed, rate-limited, vendor error) is
          // structured in the {status} return. Once this call returns, the email may
          // have been dispatched, so transient DB errors on the finalize stamp should
          // NOT cause an immediate release (they'd cause a real duplicate email on retry).
          const emailResult = await sendTaskReminderEmail({
            svc,
            task_id: r.task_id,
            tenant_id: r.tenant_id,
          });
          if (emailResult.status === "sent") status = "delivered";
          else if (emailResult.status === "suppressed") status = "suppressed";
          else status = "failed";
        } else {
          // in_app channel: cron just marks fired. The CRM nav badge reads
          // task_reminders WHERE fired_status='delivered' AND task is open.
          status = "delivered";
        }
      } catch (err) {
        // Error before any external dispatch — safe to release immediately.
        failed++;
        console.error("[task-reminders-fire] pre-dispatch error:", err);
        await safeAwait(svc
          // d091-allow:service-role-tenant — single-row update by PK (r.id from select above).
          .from("task_reminders")
          .update({ sending_at: null })
          .eq("id", r.id), "task_reminders.release_claim")
          .catch((e) => {
            console.error(`[task-reminders-fire] claim release failed for ${r.id}:`, e);
          });
        continue;
      }

      // Finalize: stamp the status. If this fails after a real send, leave the claim
      // alone — stale-claim reclaim will handle it once CLAIM_STALE_MS elapses, rather
      // than causing a near-certain duplicate on the very next batch.
      try {
        await safeAwait(svc
          // d091-allow:service-role-tenant — single-row update by globally-unique PK (r.id).
          .from("task_reminders")
          .update({ fired_at: new Date().toISOString(), fired_status: status, sending_at: null })
          .eq("id", r.id), "task_reminders.update");
        if (status === "delivered") delivered++;
        else if (status === "suppressed") suppressed++;
        else failed++;
      } catch (err) {
        failed++;
        console.error("[task-reminders-fire] finalize stamp failed:", err);
        // #1581 — DO NOT release sending_at here. A failure after sendTaskReminderEmail
        // has returned (successfully or otherwise) means the email may be in flight.
        // Releasing would allow immediate retry, causing a real duplicate email.
        // The stale-claim timeout will handle this row after CLAIM_STALE_MS.
      }
    }

    processed += rows.length;

    // Batch came back short — backlog is drained, no point re-querying.
    if (rows.length < BATCH_LIMIT) break;
  }

  return { processed, delivered, suppressed, failed, batches };
}
