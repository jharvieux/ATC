// #903 — Save a TA's manual override of their extracted voice card.
//
// The card_override field lets the TA write their own style description
// instead of (or alongside) the auto-extracted card. Phase 3 drafting
// will prefer card_override when it exists.
//
// Upserts the voice_profiles row — if extraction hasn't run yet, this
// creates a profile row with an empty style_card and the override text.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "voice_profile", action: "write" });

    let body: { card_override?: string | null; is_house_style?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const override = body.card_override !== undefined ? body.card_override : null;
    if (override !== null && override.length > 4000) {
      return Response.json({ error: "card_override max 4000 chars" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    const { data: urow, error: uErr } = await db
      .from("users").select("id, role").eq("auth_user_id", authUserId ?? "").maybeSingle();
    if (uErr) return Response.json({ error: uErr.message }, { status: 500 });
    const publicUserId = (urow as { id: string } | null)?.id ?? null;
    const role = (urow as { role?: string } | null)?.role ?? "";

    const isHouseStyle = body.is_house_style === true;
    if (isHouseStyle && role !== "tenant_owner") {
      return Response.json({ error: "only owners can edit house-style card" }, { status: 403 });
    }

    const targetUserId = isHouseStyle ? null : publicUserId;

    await safeAwait(
      db.from("voice_profiles").upsert(
        {
          tenant_id: ctx.tenant_id,
          user_id: targetUserId,
          style_card: {},
          samples_hash: "",
          card_override: override,
        },
        { onConflict: "tenant_id,user_id" },
      ),
      "voice_profiles.upsert.card_override",
    );

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
