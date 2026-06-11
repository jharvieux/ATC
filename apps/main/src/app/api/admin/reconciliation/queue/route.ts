// §14.8 — Reconciliation review queue: list and action.
//
// GET  /api/admin/reconciliation/queue?status=pending&limit=50&offset=0
//   Returns pending review items.
//
// POST /api/admin/reconciliation/queue
//   Body: { id: string, action: 'accepted' | 'rejected', notes?: string }
//   Reviews a single queue item.
//
// Platform-admin gated via assertPlatformAdmin; every mutation is wrapped
// in withPlatformAdminAudit so the audit_log row is written before the
// state change commits.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformRole, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { safeAwaitRowCount, SupabaseMutationError } from "@/lib/db/safe-mutation";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformRole(req, ["superadmin", "finance"])).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "pending";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const offset = Number(url.searchParams.get("offset") ?? "0");

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "commission_reconciliation_audit",
        operation: "reconciliation.queue.list",
      },
      async (db) => {
        const { data, error, count } = await db
          .from("reconciliation_review_queue")
          .select(
            "id, commission_id, provider_booking_ref, tenant_id, variance_cents, source_path, status, notes, created_at",
            { count: "exact" },
          )
          .eq("status", status)
          .order("created_at", { ascending: true })
          .range(offset, offset + limit - 1);

        if (error) throw new Error(error.message);
        return { items: data ?? [], total: count ?? 0, limit, offset };
      },
    );

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformRole(req, ["superadmin", "finance"])).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const body = (await req.json()) as { id?: string; action?: string; notes?: string };
  const { id, action, notes } = body;

  if (!id || !action) {
    return Response.json({ error: "Required: id, action (accepted|rejected)" }, { status: 400 });
  }
  if (action !== "accepted" && action !== "rejected") {
    return Response.json({ error: "action must be 'accepted' or 'rejected'" }, { status: 400 });
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "commission_reconciliation_audit",
        operation: "reconciliation.queue.action",
      },
      async (db) => {
        const { data: existing, error: fetchError } = await db
          .from("reconciliation_review_queue")
          .select("id, status, commission_id, notes")
          .eq("id", id)
          .single();

        if (fetchError || !existing) {
          throw Object.assign(new Error("Queue item not found"), { status: 404 });
        }

        const row = existing as { id: string; status: string; commission_id: string | null; notes: string | null };

        if (row.status !== "pending" && row.status !== "orphan") {
          throw Object.assign(new Error("Item has already been reviewed"), { status: 422 });
        }

        await safeAwaitRowCount(
          db
            .from("reconciliation_review_queue")
            .update({
              status: action,
              reviewed_at: new Date().toISOString(),
              reviewed_by: adminUserId,
              notes: notes ?? row.notes,
            })
            .eq("id", id)
            .in("status", ["pending", "orphan"])
            .select("id"),
          "reconciliation_review_queue.cas_action",
          1,
        );
        return { ok: true, id, action };
      },
    );

    return Response.json(result);
  } catch (err) {
    if (err instanceof SupabaseMutationError && err.code === "ROW_COUNT_MISMATCH") {
      return Response.json({ error: "already_actioned" }, { status: 409 });
    }
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : "Error";
    return Response.json({ error: message }, { status });
  }
}
