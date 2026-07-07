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
import { respondToAuthError } from "@/lib/auth/respond";
import { generateToken } from "@/lib/groups/invitation-token";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const InviteeSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120).optional(),
    personal_note: z.string().max(2000).optional(),
  })
  .strict();

const BodySchema = z
  .object({
    invitees: z.array(InviteeSchema).min(1).max(50),
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
          group_id: id,
          invitee_email: inv.email,
          invitee_name: inv.name ?? null,
          personal_note: inv.personal_note ?? null,
          token: await generateToken(invitationId),
        };
      }),
    );

    // invitations has no tenant_id column (PLATFORM_READABLE, #1054) — the
    // proxy injects no tenant filter. Isolation holds via group_id: id, which
    // was verified tenant-owned by the tenant-scoped groups query above.
    const { error: insertErr } = await db.from("invitations").insert(rows);
    if (insertErr) {
      return dbErrorResponse(insertErr);
    }

    return Response.json(
      { added: rows.length, invitation_ids: rows.map((r) => r.id) },
      { status: 201 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}
