// §15.11 — Admin review queue: pending tenant applications.
// GET: paginated list of tenants in review_decision = 'pending'.
// Visible only to superadmin (reviewer access removed per #1003).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "tenants")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = 25;
  const offset = (page - 1) * pageSize;

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "cross_tenant_admin",
        operation: "onboarding.review_queue.list",
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "tenants" });
        const { data, error, count } = await db
          .from("tenants")
          .select(
            "id, slug, display_name, legal_name, tenant_type, state_of_operation, tier_id, seat_count, billing_period, review_decision, created_at",
            { count: "exact" },
          )
          .eq("review_decision", "pending")
          .order("created_at", { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (error) throw new Error(error.message);
        return { tenants: data, total: count ?? 0 };
      },
    );

    return Response.json({ ...result, page, page_size: pageSize });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
