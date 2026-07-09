// §11.6 — 24-hour undo window for anonymous→authenticated session transfer.
//
// POST /api/auth/transfer-session/undo  { anonymous_session_id }
//
// Soft-commit transfers (transfer_soft_commit_at set, transfer_committed_at
// null) can be undone within 24 hours. After 24h the transfer-finalize
// Inngest job sets transfer_committed_at and the undo is rejected (409).
//
// Fail-closed checks (each its own 4xx):
//   - Caller is authenticated (assertPermission validates JWT).
//   - The named anonymous_sessions row was actually transferred to the
//     authenticated caller (transferred_to_user_id === user.id).
//   - The transfer hasn't been finalized.
//   - The 24h window hasn't elapsed.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const BodySchema = z.object({
  anonymous_session_id: z.string().uuid(),
}).strict();

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "SessionTransfer",
      action: "undo",
    });

    const body: unknown = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }

    const svc = createServiceRoleClient();

    // Fail-closed lookup, scoped to the caller's tenant. anonymous_sessions
    // is per-tenant; a user authenticated to tenant A must not be able to
    // undo a transfer that happened on tenant B's host (cross-tenant audit
    // log misfiling + cross-tenant visibility).
    const { data: session, error: readErr } = await svc
      .from("anonymous_sessions")
      .select("id, transferred_to_user_id, transfer_soft_commit_at, transfer_committed_at")
      .eq("id", parsed.data.anonymous_session_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();

    if (readErr) {
      return dbErrorResponse(readErr);
    }
    if (!session) {
      // Could be "doesn't exist" or "belongs to a different tenant" — same
      // response either way (deliberate: don't leak existence across tenants).
      return Response.json({ error: "session_not_found" }, { status: 404 });
    }
    const row = session as {
      id: string;
      transferred_to_user_id: string | null;
      transfer_soft_commit_at: string | null;
      transfer_committed_at: string | null;
    };

    if (row.transferred_to_user_id !== user.id) {
      return Response.json({ error: "not_owner" }, { status: 403 });
    }
    if (row.transfer_committed_at) {
      return Response.json({ error: "transfer_already_finalized" }, { status: 409 });
    }
    if (!row.transfer_soft_commit_at) {
      return Response.json({ error: "transfer_not_in_soft_commit" }, { status: 409 });
    }
    const ageMs = Date.now() - new Date(row.transfer_soft_commit_at).getTime();
    if (ageMs >= UNDO_WINDOW_MS) {
      return Response.json({ error: "undo_window_elapsed" }, { status: 409 });
    }

    // #1703 — Atomic undo: one RPC does the CAS clear of the soft-commit state
    // AND the conversation revert in a single transaction. Splitting these into
    // two dependent app-layer writes (D-091 pattern 21/22) left a dead-retry
    // window: if the conversation revert failed after the CAS committed, the
    // session read as "undone" (transferred_to_user_id NULL) so a re-POST hit
    // the not_owner 403 before the revert could re-run, stranding conversations
    // owned by the user. The RPC's CAS guard mirrors the pre-checks above; it
    // returns the number of session rows updated. Zero means the finalize cron
    // won the race between our pre-check read and the RPC → 409 (recoverable
    // info the user can act on), and the conversation revert never ran. The
    // pending finalize Inngest event no-ops on arrival: transfer_soft_commit_at
    // is now NULL.
    const { data: undoneCount, error: rpcErr } = await svc.rpc("undo_session_transfer", {
      p_session_id: parsed.data.anonymous_session_id,
      p_tenant_id: ctx.tenant_id,
      p_user_id: user.id,
    });

    if (rpcErr) {
      // Fail-closed: a genuine RPC/DB failure is a sanitized 500, never a
      // silent success.
      return dbErrorResponse(rpcErr);
    }
    if (!undoneCount) {
      return Response.json(
        { error: "transfer_already_finalized" },
        { status: 409 },
      );
    }

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "session_transfer.undone",
      resource_type: "anonymous_session",
      resource_id: row.id,
      changes: {
        soft_commit_at: row.transfer_soft_commit_at,
        undone_at: new Date().toISOString(),
      },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
