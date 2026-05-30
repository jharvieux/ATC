// §7.7 / §18 — Add invitations to an existing group.
//
// "Members" in the spec are people who accepted invitations; adding a
// member after group creation is mechanically the same as sending an
// additional invitation (RSVP gates actual membership). §18.10 sailed
// groups are read-only.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { generateToken } from "@/lib/groups/invitation-token";
import { assertGroupNotSailed, GroupSailedError } from "@/lib/groups/sailed-gate";

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
      return Response.json({ error: groupErr.message }, { status: 500 });
    }
    if (!groupRow) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // §18.10 — sailed groups are read-only.
    try {
      await assertGroupNotSailed(db, id);
    } catch (err) {
      if (err instanceof GroupSailedError) {
        return Response.json(
          { error: "group_sailed", sailed_at: err.sailed_at },
          { status: 410 },
        );
      }
      throw err;
    }

    const rows = invitees.map((inv) => {
      const invitationId = randomUUID();
      return {
        id: invitationId,
        group_id: id,
        invitee_email: inv.email,
        invitee_name: inv.name ?? null,
        personal_note: inv.personal_note ?? null,
        token: generateToken(invitationId),
      };
    });

    const { error: insertErr } = await db.from("invitations").insert(rows);
    if (insertErr) {
      return Response.json({ error: insertErr.message }, { status: 500 });
    }

    return NextResponse.json(
      { added: rows.length, invitation_ids: rows.map((r) => r.id) },
      { status: 201 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}
