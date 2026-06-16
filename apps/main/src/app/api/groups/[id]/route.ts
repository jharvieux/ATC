// §7.7 / §18 — Group detail.
//
// Includes counts grouped by invitation.rsvp_state so the coordinator UI can
// render the RSVP-state chips (pending/interested/not_going/booked) in one
// round-trip. (#1056: invitations has no `status` column — RSVP state lives in
// `rsvp_state`; selecting `status` hard-500'd this endpoint.)

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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
  rsvp_state: string;
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
      return dbErrorResponse(groupErr);
    }
    if (!groupRow) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Aggregate invitation counts by RSVP state. Client app-side accumulation
    // keeps the query simple and avoids a SQL group-by RPC.
    const { data: invRows, error: invErr } = await db
      .from("invitations")
      .select("rsvp_state")
      .eq("group_id", id);
    if (invErr) {
      return dbErrorResponse(invErr);
    }
    const counts: Record<string, number> = {};
    for (const r of (invRows ?? []) as InvitationCountRow[]) {
      const rsvp_state = r.rsvp_state ?? "unknown";
      counts[rsvp_state] = (counts[rsvp_state] ?? 0) + 1;
    }

    const group = groupRow as unknown as GroupRow;
    return Response.json({ group, invitation_counts: counts });
  } catch (err) {
    return respondToAuthError(err);
  }
}
