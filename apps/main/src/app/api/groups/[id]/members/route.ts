// §7.7 / §18 — Add invitations to an existing group.
//
// "Members" in the spec are people who accepted invitations; adding a
// member after group creation is mechanically the same as sending an
// additional invitation (RSVP gates actual membership). §18.10 sailed
// groups are read-only.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { generateToken } from "@/lib/groups/invitation-token";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { MAX_INVITEES_PER_GROUP } from "@/lib/groups/constants";

const InviteeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120).optional(),
    personal_note: z.string().max(2000).optional(),
  })
  .strict();

const BodySchema = z
  .object({
    // #1680 — same 50-cap constant as the create + single-invite paths (no
    // per-path literal to drift). This is a per-request batch bound; the
    // cumulative group cap is enforced atomically below via the
    // reserve_group_invitations RPC (#1875).
    invitees: z.array(InviteeSchema).min(1).max(MAX_INVITEES_PER_GROUP),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "groups",
      action: "invite",
    });

    const body: unknown = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const { invitees } = parsed.data;

    const { id } = await params;
    const db = tenantClient(ctx);

    // Verify the group exists in this tenant before any mutation. RLS hides
    // cross-tenant rows, so a 404 here covers both missing and other-tenant.
    const { data: groupRow, error: groupErr } = await db
      // d091-allow:service-role-tenant — this is the tenantClient proxy (not the raw service-role client below), which auto-injects .eq("tenant_id", ctx.tenant_id) on select.
      .from("groups")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (groupErr) {
      return dbErrorResponse(groupErr);
    }
    if (!groupRow) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // §18.10 — sailed groups are read-only.
    try {
      await assertGroupNotSailed(db, id, ctx.tenant_id);
    } catch (err) {
      if (err instanceof GroupSailedError) {
        return Response.json(
          { error: "group_sailed", sailed_at: err.sailed_at },
          { status: 410 },
        );
      }
      throw err;
    }

    const rows = await Promise.all(
      invitees.map(async (inv) => {
        const invitationId = randomUUID();
        return {
          id: invitationId,
          invitee_email: inv.email,
          invitee_name: inv.name ?? null,
          personal_note: inv.personal_note ?? null,
          token: await generateToken(invitationId),
        };
      }),
    );

    // #1875 — enforce the cumulative 50-active-invitee cap atomically. This
    // batch insert previously had NO cap check (only the per-request Zod .max),
    // so repeated calls could push a group past 50. The reserve RPC takes a
    // group-scoped advisory lock, re-counts active invitees, and inserts the
    // whole batch in one transaction — rejecting when existing + batch would
    // exceed the cap (same atomic reserve that closes #1680's single-invite
    // TOCTOU). invitations has no tenant_id column (PLATFORM_READABLE, #1054);
    // isolation holds via group_id, verified tenant-owned by the tenant-scoped
    // groups query above.
    const svc = createServiceRoleClient();
    const { data: reserve, error: reserveErr } = await svc.rpc(
      "reserve_group_invitations",
      { p_group_id: id, p_invitations: rows, p_max: MAX_INVITEES_PER_GROUP },
    );
    if (reserveErr) {
      return dbErrorResponse(reserveErr);
    }
    const reserveStatus = (reserve as { status?: string } | null)?.status;
    if (reserveStatus === "cap_exceeded") {
      return Response.json(
        { error: `Maximum ${MAX_INVITEES_PER_GROUP} invitees per group` },
        { status: 400 },
      );
    }
    // Fail loud on any unexpected verdict — never fall through to 201 having
    // possibly inserted nothing (mirrors the single-invite route).
    if (reserveStatus !== "ok") {
      return dbErrorResponse(
        new Error(`reserve_group_invitations returned unexpected status: ${String(reserveStatus)}`),
      );
    }

    return Response.json(
      { added: rows.length, invitation_ids: rows.map((r) => r.id) },
      { status: 201 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}
