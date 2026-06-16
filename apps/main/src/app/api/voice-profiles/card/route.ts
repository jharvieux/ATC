// #903 — Save a TA's manual override of their extracted voice card.
//
// PATCH updates only card_override — does NOT touch style_card or samples_hash.
// If no profile row exists yet (extraction hasn't run), inserts a minimal row.

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
    if (uErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    const publicUserId = (urow as { id: string } | null)?.id ?? null;
    const role = (urow as { role?: string } | null)?.role ?? "";

    const isHouseStyle = body.is_house_style === true;
    if (isHouseStyle && role !== "tenant_owner") {
      return Response.json({ error: "only owners can edit house-style card" }, { status: 403 });
    }

    const targetUserId = isHouseStyle ? null : publicUserId;

    // Load the existing row to decide insert vs update.
    // .is() only works for null/boolean — use .eq() for non-null user_id.
    const existingBase = db.from("voice_profiles").select("id");
    const { data: existing, error: existErr } = await (
      targetUserId === null
        ? existingBase.is("user_id", null)
        : existingBase.eq("user_id", targetUserId)
    ).maybeSingle();
    if (existErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    const existingId = (existing as { id: string } | null)?.id ?? null;

    if (existingId) {
      // Only update card_override — preserve the extracted style_card.
      await safeAwait(
        db.from("voice_profiles").update({ card_override: override }).eq("id", existingId),
        "voice_profiles.update.card_override",
      );
    } else {
      await safeAwait(
        db.from("voice_profiles").insert({
          tenant_id: ctx.tenant_id,
          user_id: targetUserId,
          style_card: {},
          samples_hash: "",
          card_override: override,
        }),
        "voice_profiles.insert.card_override",
      );
    }

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
