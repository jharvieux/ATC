// §11.6 — Transfer finalize Inngest job.
//
// Fires 24 hours after softCommitTransfer. At that point the soft-commit
// window has elapsed and the transfer is made permanent.
//
// Undo cancellation approach: rather than cancelling the Inngest event
// (which requires the Inngest SDK's cancelOn machinery and a separate
// cancel event), the finalize function re-reads the session on arrival.
// If transfer_soft_commit_at is NULL (i.e., undoTransfer cleared it),
// this function no-ops. This is the "no-op flag on re-read" approach
// documented in MEMORY.md.
//
// On commit, each side effect is its OWN Inngest step so the commit and the
// post-commit work are independently checkpointed. If the commit lands but a
// later side effect throws, Inngest retries from the failed step — the read
// and commit steps replay from memoized state (no double-commit), and the
// un-run side effects finally execute. Structuring these as plain awaits was
// the original defect: a retry re-read a now-committed row, early-returned
// "already_committed", and dropped memory extraction + contact binding.
//   - Commits transfer_committed_at = NOW() (CAS-guarded).
//   - Emits conversation.memory_extract_requested for each transferred conversation.
//   - Binds a CRM contact for the authenticated user.
//   - TODO(pre-cruise-emails): schedule pre-cruise emails for active bookings.

import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
// INNGEST-PROBE-ALLOW-MIXED: bindContactOnIdentification writes to
// attribution_touches across tenant scope inside an already-tenanted
// Inngest run; primary work uses tenantClient(ctx).
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { bindContactOnIdentification } from "@/lib/attribution/bind-contact-on-identification";
import { safeAwaitRowCount, SupabaseMutationError } from "@/lib/db/safe-mutation";

export const transferFinalize = inngest.createFunction(
  {
    id: "transfer-finalize",
    triggers: [{ event: "anonymous_session.transfer_finalize" }],
    retries: 3,
  },
  async ({ event, step }) => {
    const anonymous_session_id = event.data.anonymous_session_id as string;
    const user_id = event.data.user_id as string;
    const tenant_id = event.data.tenant_id as string;

    const ctx = tenantContextFromInngestEvent(
      event as { id: string; name: string; data: Record<string, unknown> },
    );
    const db = tenantClient(ctx);

    // Re-read the session to check if the transfer was undone during the window.
    // Audit pass 2, Finding 10: also re-verify that this session belongs to
    // the tenant and was scheduled to transfer to the user named in the
    // event payload. Without this check, a crafted Inngest event with
    // mismatched IDs could commit a victim's session to an attacker's
    // user_id, attributing victim conversations + memories to the attacker.
    //
    // This read is its own step so its result is MEMOIZED: on a retry after
    // the commit succeeded but a later side effect (memory emit / contact
    // bind) threw, Inngest replays this step's original view (committed_at
    // still null) rather than re-reading a now-committed row. Without that,
    // the retry would early-return "already_committed" and the un-run side
    // effects would be lost forever (the defect this fix closes).
    const session = await step.run("read-session", async () => {
      const { data, error } = await db
        .from("anonymous_sessions")
        .select(
          "id, transfer_soft_commit_at, transfer_committed_at, transferred_to_user_id, tenant_id",
        )
        .eq("id", anonymous_session_id)
        .maybeSingle();
      if (error) throw new Error(`transfer-finalize: session read error — ${error.message}`);
      return data as {
        id: string;
        tenant_id: string;
        transferred_to_user_id: string | null;
        transfer_soft_commit_at: string | null;
        transfer_committed_at: string | null;
      } | null;
    });

    // Already finalized by a prior COMPLETED run (duplicate event) — idempotent.
    if (session?.transfer_committed_at) return { status: "already_committed" };

    // Transfer was undone — no-op.
    if (!session?.transfer_soft_commit_at) return { status: "undone_noop" };

    // Cross-check the event payload against the session row. If they
    // diverge, the event was crafted or stale — refuse to commit.
    if (session.tenant_id !== tenant_id) {
      console.warn(
        "[transfer-finalize] tenant mismatch: event.tenant_id=%s, session.tenant_id=%s",
        tenant_id,
        session.tenant_id,
      );
      return { status: "tenant_mismatch_refused" };
    }
    if (session.transferred_to_user_id && session.transferred_to_user_id !== user_id) {
      console.warn(
        "[transfer-finalize] user mismatch: event.user_id=%s, session.transferred_to_user_id=%s",
        user_id,
        session.transferred_to_user_id,
      );
      return { status: "user_mismatch_refused" };
    }

    // Commit the transfer as its own step (CAS-guarded). If undo cleared
    // transfer_soft_commit_at between the read step and now, the CAS matches
    // zero rows → we stop without committing (undo wins). A genuine DB error
    // throws → Inngest retries this step only.
    const commitOutcome = await step.run("commit-transfer", async () => {
      const now = new Date().toISOString();
      try {
        await safeAwaitRowCount(
          db
            .from("anonymous_sessions")
            .update({ transfer_committed_at: now })
            .eq("id", anonymous_session_id)
            .eq("tenant_id", tenant_id)
            .is("transfer_committed_at", null)
            .not("transfer_soft_commit_at", "is", null)
            .select("id"),
          "anonymous_sessions.finalize_commit",
          1,
        );
        return { committed: true as const };
      } catch (commitErr) {
        if (commitErr instanceof SupabaseMutationError && commitErr.code === "ROW_COUNT_MISMATCH") {
          return { committed: false as const };
        }
        throw commitErr;
      }
    });

    // Undo raced in and cleared the soft-commit before we committed.
    if (!commitOutcome.committed) return { status: "undone_noop" };

    // Find all conversations that were transferred (memoized step).
    const convIds = await step.run("fetch-conversations", async () => {
      const { data, error } = await db
        .from("conversations")
        .select("id")
        .eq("anonymous_session_id", anonymous_session_id)
        .eq("user_id", user_id);
      if (error) throw new Error(`transfer-finalize: conversation fetch error — ${error.message}`);
      return (data ?? []).map((c: { id: string }) => c.id);
    });

    // Emit memory extraction for each transferred conversation. Its own step:
    // once it completes it is memoized and never re-emits, even if a later
    // step (contact bind) fails and forces a retry — exactly-once emission.
    if (convIds.length > 0) {
      await step.sendEvent(
        "emit-memory-extractions",
        convIds.map((conversation_id: string) => ({
          name: "conversation.memory_extract_requested" as const,
          data: { tenant_id, conversation_id, user_id },
        })),
      );
    }

    // §35.2.2 — bind a CRM contact to the now-identified user and write an
    // attribution touch. Its own step so it runs on the already-committed
    // path even when a prior invocation committed but died here; a failure
    // throws so Inngest retries THIS step (bind is idempotent on the contact
    // — it looks the contact up before creating). Pending UTM cookie is not
    // available in this Inngest path (transfer fires 24h after the user
    // identified); we attribute as 'direct' on the touch.
    const bindResult = await step.run("bind-contact", async () => {
      const r = await bindContactOnIdentification({
        svc: createServiceRoleClient(),
        tenant_id,
        user_id,
        source_origin: "utm_parsed", // representative of an organic identification path
        pending_payload: null,
      });
      if (!r.ok) {
        throw new Error(`transfer-finalize: bindContactOnIdentification failed — ${r.error}`);
      }
      return r;
    });

    // TODO(pre-cruise-emails): schedule pre-cruise emails for active bookings.

    return {
      status: "committed",
      conversations_transferred: convIds.length,
      contact_id: bindResult.contact_id,
      contact_was_new: bindResult.was_new_contact,
    };
  },
);
