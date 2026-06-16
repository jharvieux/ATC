// §11.6 — return the caller's pending (soft-committed, not yet finalized)
// session transfer so the /settings/conversations page can mount UndoBanner.
//
// GET /api/user/pending-transfer
//   200 { pending: null }
//   200 { pending: { anonymous_session_id, transfer_soft_commit_at, transfer_committed_at } }
//
// transfer_committed_at is always null in the returned shape (we only return
// pending ones). The banner reads it to decide whether to render the
// "made permanent" copy or the active undo CTA — kept in the type so the
// banner doesn't need a second fetch when it eventually flips.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "PendingTransfer",
      action: "read",
    });

    const svc = createServiceRoleClient();

    // Scoped to the caller's tenant. anonymous_sessions is per-tenant; a
    // user authenticated to tenant A must not see a pending transfer that
    // happened on tenant B's host (the banner there is tenant B's concern
    // and would also fail the corresponding undo POST per its tenant_id
    // filter — so there's no point surfacing it here).
    //
    // The most recent soft-commit row for this user in this tenant that
    // hasn't been finalized yet. Normally at most one — the upstream
    // transfer flow prevents stacking — but ordering handles the edge of
    // a re-transfer in the same session.
    const { data, error } = await svc
      .from("anonymous_sessions")
      .select("id, transfer_soft_commit_at, transfer_committed_at")
      .eq("tenant_id", ctx.tenant_id)
      .eq("transferred_to_user_id", user.id)
      .is("transfer_committed_at", null)
      .not("transfer_soft_commit_at", "is", null)
      .order("transfer_soft_commit_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return dbErrorResponse(error);

    if (!data) return Response.json({ pending: null });

    const row = data as { id: string; transfer_soft_commit_at: string; transfer_committed_at: string | null };
    return Response.json({
      pending: {
        anonymous_session_id: row.id,
        transfer_soft_commit_at: row.transfer_soft_commit_at,
        transfer_committed_at: row.transfer_committed_at,
      },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
