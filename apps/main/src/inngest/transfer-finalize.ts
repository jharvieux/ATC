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
// On commit:
//   - Sets transfer_committed_at = NOW().
//   - Emits conversation.memory_extract_requested for each transferred conversation.
//   - TODO(prompt-13): create CRM contact for the authenticated user.
//   - TODO(pre-cruise-emails): schedule pre-cruise emails for active bookings.

import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
// INNGEST-PROBE-ALLOW-MIXED: bindContactOnIdentification writes to
// attribution_touches across tenant scope inside an already-tenanted
// Inngest run; primary work uses tenantClient(ctx).
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { bindContactOnIdentification } from "@/lib/attribution/bind-contact-on-identification";

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
    const { data: session, error: readErr } = await db
      .from("anonymous_sessions")
      .select("id, transfer_soft_commit_at, transfer_committed_at")
      .eq("id", anonymous_session_id)
      .maybeSingle();

    if (readErr) throw new Error(`transfer-finalize: session read error — ${readErr.message}`);

    // Already finalized (idempotent re-run).
    if (session?.transfer_committed_at) return { status: "already_committed" };

    // Transfer was undone — no-op.
    if (!session?.transfer_soft_commit_at) return { status: "undone_noop" };

    // Commit the transfer.
    const now = new Date().toISOString();
    const { error: commitErr } = await db
      .from("anonymous_sessions")
      .update({ transfer_committed_at: now })
      .eq("id", anonymous_session_id);

    if (commitErr) throw new Error(`transfer-finalize: commit error — ${commitErr.message}`);

    // Find all conversations that were transferred.
    const { data: conversations, error: convErr } = await db
      .from("conversations")
      .select("id")
      .eq("anonymous_session_id", anonymous_session_id)
      .eq("user_id", user_id);

    if (convErr) throw new Error(`transfer-finalize: conversation fetch error — ${convErr.message}`);

    // Emit memory extraction for each transferred conversation.
    const convIds = (conversations ?? []).map((c: { id: string }) => c.id);
    if (convIds.length > 0) {
      await step.sendEvent(
        "emit-memory-extractions",
        convIds.map((conversation_id: string) => ({
          name: "conversation.memory_extract_requested" as const,
          data: { tenant_id, conversation_id, user_id },
        })),
      );
    }

    // §35.2.2 — bind a CRM contact to the now-identified user and write
    // an attribution touch. Pending UTM cookie is not available in this
    // Inngest path (transfer fires 24h after the user identified); we
    // attribute as 'direct' on the touch. The first-touch column on the
    // contact captures whatever data we have at this point.
    const bindResult = await bindContactOnIdentification({
      svc: createServiceRoleClient(),
      tenant_id,
      user_id,
      source_origin: "utm_parsed", // representative of an organic identification path
      pending_payload: null,
    });
    if (!bindResult.ok) {
      console.warn("[transfer-finalize] bindContactOnIdentification failed:", bindResult.error);
    }

    // TODO(pre-cruise-emails): schedule pre-cruise emails for active bookings.

    return {
      status: "committed",
      conversations_transferred: convIds.length,
      ...(bindResult.ok ? { contact_id: bindResult.contact_id, contact_was_new: bindResult.was_new_contact } : {}),
    };
  },
);
