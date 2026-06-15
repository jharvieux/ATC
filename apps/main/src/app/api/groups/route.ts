// §18.2 — Create a group booking and issue HMAC-signed invitations.
//
// POST /api/groups
//   Body: { cruise_line, ship_name, sailing_date, departure_port,
//            max_cabins?, target_group_rate_cents?, coordinator_message?,
//            visibility_default?, hero_image_url?,
//            invitees: [{ email, name?, personal_note? }][] }
//
// On success: status transitions planning→active; per-invitee tokens generated;
// invitation rows inserted. Returns { group_id, invitation_count }.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";
import { generateToken } from "@/lib/groups/invitation-token";
import { selectHeroImage } from "@/lib/groups/hero-image";
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { incrementGroupInvitees } from "@/lib/abuse/counters";
import { respondToAuthError } from "@/lib/auth/respond";

interface InviteeInput {
  email: string;
  name?: string;
  personal_note?: string;
}

interface CreateGroupBody {
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  max_cabins?: number;
  target_group_rate_cents?: number;
  coordinator_message?: string;
  visibility_default?: "visible" | "hidden";
  hero_image_url?: string;
  invitees: InviteeInput[];
  // #783 Phase 3 — catalog FK (optional; populated by the cascade-dropdown UX).
  sailing_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "groups", action: "create" });

    const body = await req.json() as CreateGroupBody;
    const {
      cruise_line, ship_name, sailing_date, departure_port,
      max_cabins, target_group_rate_cents, coordinator_message,
      visibility_default = "visible", hero_image_url,
      invitees = [],
      sailing_id,
    } = body;

    if (!cruise_line || !ship_name || !sailing_date || !departure_port) {
      return Response.json({ error: "cruise_line, ship_name, sailing_date, departure_port are required" }, { status: 400 });
    }
    if (invitees.length > 50) {
      return Response.json({ error: "Maximum 50 invitees per group" }, { status: 400 });
    }

    const svc = createServiceRoleClient();

    // Select hero image via priority chain.
    const heroUrl = await selectHeroImage({
      tenant_id: ctx.tenant_id,
      tier: "sub_host_starter", // TODO(rbac): read actual tier from tenant row
      destination: departure_port,
      cruise_line,
      coordinator_url: hero_image_url ?? null,
    });

    const [lineRes, shipRes] = await Promise.all([
      resolveCanonical(cruise_line, "line", svc),
      resolveCanonical(ship_name, "ship", svc),
    ]);

    // Insert group row (status: active — transitions from planning on send).
    const { data: group, error: groupErr } = await svc
      .from("groups")
      .insert({
        tenant_id: ctx.tenant_id,
        coordinator_user_id: user.id,
        status: "active",
        cruise_line,
        ship_name,
        sailing_date,
        departure_port,
        ...(max_cabins !== undefined && { max_cabins }),
        ...(target_group_rate_cents !== undefined && { target_group_rate_cents }),
        ...(coordinator_message !== undefined && { coordinator_message }),
        visibility_default,
        hero_image_url: heroUrl,
        ...(lineRes.matched && { cruise_line_id: lineRes.id }),
        ...(shipRes.matched && { cruise_ship_id: shipRes.id }),
        ...(sailing_id !== undefined && { sailing_id }),
      })
      .select("id")
      .single();

    if (groupErr || !group) {
      return Response.json({ error: groupErr?.message ?? "Failed to create group" }, { status: 500 });
    }

    // Generate HMAC tokens and insert invitations.
    if (invitees.length > 0) {
      const rows = invitees.map((inv) => {
        const id = crypto.randomUUID();
        const token = generateToken(id);
        return {
          id,
          group_id: group.id,
          invitee_email: inv.email,
          invitee_name: inv.name ?? null,
          personal_note: inv.personal_note ?? null,
          token,
        };
      });

      const { error: invErr } = await svc.from("invitations").insert(rows);
      if (invErr) {
        return Response.json({ error: invErr.message }, { status: 500 });
      }

      // BP27 §27.4 — bump the group-invitees counter. Non-fatal on
      // failure: the invitations already exist; we don't want to
      // surface a 500 to the coordinator because attribution is sad.
      try {
        const snapshot = await loadTenantSnapshot(svc, ctx.tenant_id);
        await incrementGroupInvitees({ db: svc, tenant: snapshot.tenant }, rows.length);
      } catch (err) {
        console.warn(`[groups] counter increment failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return Response.json({ group_id: group.id, invitation_count: invitees.length }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "groups", action: "list" });

    const svc = createServiceRoleClient();

    const { data, error } = await svc
      .from("groups")
      .select("id,status,cruise_line,ship_name,sailing_date,departure_port,hero_image_url,created_at,cruise_line_id,cruise_lines(display_name)")
      .eq("tenant_id", ctx.tenant_id)
      .order("sailing_date", { ascending: true });

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ groups: data });
  } catch (err) {
    return respondToAuthError(err);
  }
}
