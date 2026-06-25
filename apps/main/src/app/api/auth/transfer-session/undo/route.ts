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
import { safeAwaitRowCount, SupabaseMutationError } from "@/lib/db/safe-mutation";
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
      .select("id, transferred_to_user_id, transfer_soft_commit_at, transfer_committed_at, transfer_undo_count")
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
      transfer_undo_count: number;
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

    // CAS update: only flip if the row is still in the soft-commit state.
    // Prevents a race with the transfer-finalize Inngest job firing between
    // our pre-check and this update. Zero-row → finalize cron won the race
    // → return 409, not 500 (the user can see this is recoverable info).
    try {
      await safeAwaitRowCount(
        svc.from("anonymous_sessions")
          .update({
            transfer_soft_commit_at: null,
            transferred_to_user_id: null,
            transfer_undo_count: row.transfer_undo_count + 1,
          })
          .eq("id", row.id)
          .eq("tenant_id", ctx.tenant_id)
          .eq("transferred_to_user_id", user.id)
          .is("transfer_committed_at", null)
          .not("transfer_soft_commit_at", "is", null)
          .select("id"),
        "anonymous_sessions.undo_transfer",
        1,
      );
    } catch (casErr) {
      if (casErr instanceof SupabaseMutationError && casErr.code === "ROW_COUNT_MISMATCH") {
        // Lost the race with the finalize cron between pre-check and CAS.
        return Response.json(
          { error: "transfer_already_finalized" },
          { status: 409 },
        );
      }
      throw casErr;
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
