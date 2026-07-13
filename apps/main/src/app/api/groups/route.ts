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
import { sendGroupInvitationEmail, type GroupInvitationGroup } from "@/lib/groups/send-invitation-email";
import { selectHeroImage } from "@/lib/groups/hero-image";
import { loadTenantSnapshot } from "@/lib/abuse/snapshot";
import { getTenantTierCode } from "@/lib/tenancy/get-tenant-tier-code";
import { incrementGroupInvitees } from "@/lib/abuse/counters";
import { hardDeleteGroup } from "@/lib/groups/delete-group";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { MAX_INVITEES_PER_GROUP } from "@/lib/groups/constants";

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
    if (invitees.length > MAX_INVITEES_PER_GROUP) {
      return Response.json({ error: `Maximum ${MAX_INVITEES_PER_GROUP} invitees per group` }, { status: 400 });
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (sailing_id !== undefined && !UUID_RE.test(sailing_id)) {
      return Response.json({ error: "sailing_id must be a valid UUID" }, { status: 400 });
    }

    const svc = createServiceRoleClient();

    // Select hero image via priority chain.
    const heroUrl = await selectHeroImage({
      tenant_id: ctx.tenant_id,
      tier: await getTenantTierCode(svc, ctx.tenant_id),
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
      return dbErrorResponse(groupErr);
    }

    // One forum per group (§19.1). The forum GET route only reads, so the row
    // must be created here — without it the group's Forum tab 404s. Non-fatal:
    // the group already exists; a forum-insert failure shouldn't 500 the create
    // (it's backfillable and the unique constraint makes a retry idempotent).
    const { error: forumErr } = await svc
      .from("forums")
      .insert({ group_id: group.id, tenant_id: ctx.tenant_id });
    if (forumErr) {
      console.error(`[groups] forum auto-create failed for group=${group.id}: ${forumErr.message}`);
    }

    // Generate HMAC tokens and insert invitations.
    if (invitees.length > 0) {
      const rows = await Promise.all(
        invitees.map(async (inv) => {
          const id = crypto.randomUUID();
          const token = await generateToken(id);
          return {
            id,
            group_id: group.id,
            invitee_email: inv.email,
            invitee_name: inv.name ?? null,
            personal_note: inv.personal_note ?? null,
            token,
          };
        }),
      );

      const { error: invErr } = await svc.from("invitations").insert(rows);
      if (invErr) {
        // #1600 — an invitations-insert failure must not leave the group
        // active and orphaned (empty, un-retryable without duplicating).
        // Use hardDeleteGroup to ensure all non-cascading FKs (email_log,
        // group_invite_pending_approval) are handled in the right order.
        try {
          await hardDeleteGroup(group.id);
        } catch (err) {
          console.error(`[groups] compensating delete failed for group=${group.id} after invitations insert failure`, err);
        }
        return dbErrorResponse(invErr);
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

      // Send the invitations immediately. Previously create-time invitees only
      // got the daily §18.8 reminder cron — coordinators expect the invite to go
      // out now. sendGroupInvitationEmail is fail-silent (logs, never throws), so
      // a delivery problem can't fail the create; the rows already exist.
      const emailGroup: GroupInvitationGroup = {
        id: group.id,
        cruise_line,
        ship_name,
        sailing_date,
        departure_port,
        coordinator_message: coordinator_message ?? null,
        hero_image_url: heroUrl,
      };
      await Promise.all(
        rows.map((r) =>
          sendGroupInvitationEmail({ svc, invitationId: r.id, group: emailGroup, tenantId: ctx.tenant_id }),
        ),
      );
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

    // #1588: explicit bound — same limit/offset shape as GET /api/crm/contacts
    // — instead of an unlimited select PostgREST would silently truncate.
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const { data, error, count } = await svc
      .from("groups")
      .select("id,status,cruise_line,ship_name,sailing_date,departure_port,hero_image_url,created_at,cruise_line_id,cruise_lines(display_name)", { count: "exact" })
      .eq("tenant_id", ctx.tenant_id)
      .order("sailing_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return dbErrorResponse(error);
    return Response.json({ groups: data, total: count ?? 0, limit, offset });
  } catch (err) {
    return respondToAuthError(err);
  }
}
