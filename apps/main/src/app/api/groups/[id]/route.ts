// §7.7 / §18 — Group detail.
//
// Includes counts grouped by invitation.status so the coordinator UI can
// render member/pending/declined chips in one round-trip.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const GROUP_COLUMNS =
  "id, tenant_id, coordinator_user_id, status, cruise_line, ship_name, " +
  "sailing_date, departure_port, max_cabins, target_group_rate_cents, " +
  "coordinator_message, visibility_default, hero_image_url, sailed_at, " +
  "created_at, updated_at";

interface GroupRow {
  id: string;
  status: string;
}

interface InvitationCountRow {
  status: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "groups",
      action: "read",
    });

    const { id } = await params;
    const db = tenantClient(ctx);

    const { data: groupRow, error: groupErr } = await db
      .from("groups")
      .select(GROUP_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (groupErr) {
      return Response.json({ error: groupErr.message }, { status: 500 });
    }
    if (!groupRow) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Aggregate invitation counts. Client app-side accumulation keeps the
    // query simple and avoids a SQL group-by RPC.
    const { data: invRows, error: invErr } = await db
      .from("invitations")
      .select("status")
      .eq("group_id", id);
    if (invErr) {
      return Response.json({ error: invErr.message }, { status: 500 });
    }
    const counts: Record<string, number> = {};
    for (const r of (invRows ?? []) as InvitationCountRow[]) {
      const status = r.status ?? "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
    }

    const group = groupRow as unknown as GroupRow;
    return Response.json({ group, invitation_counts: counts });
  } catch (err) {
    return respondToAuthError(err);
  }
}
