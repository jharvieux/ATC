// #903 / D-193 — Voice sample CRUD.
//
// GET  — list samples for the caller (own + house style if owner).
// POST — add a sample; dispatches extraction event.
//
// Tenant isolation: two layers.
//   DB layer:  tenantClient(ctx) auto-injects .eq("tenant_id") on every read.
//   App layer: user_id resolved from auth_user_id before filtering.
//
// Deletions are service-role only (RLS DELETE=false); see DELETE /[id]/route.ts.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { inngest } from "@/inngest/client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "voice_profile",
      action: "read",
    });
    const db = tenantClient(ctx);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    // Resolve auth_user_id → public.users.id (same pattern as other routes).
    let publicUserId: string | null = null;
    if (authUserId) {
      const { data: urow, error: uErr } = await db
        .from("users").select("id, role").eq("auth_user_id", authUserId).maybeSingle();
      if (uErr) return dbErrorResponse(uErr);
      publicUserId = (urow as { id: string } | null)?.id ?? null;
      const role = (urow as { role?: string } | null)?.role ?? "";

      // Load the caller's own samples.
      // .is() only works for null/boolean — use .eq() for non-null user_id.
      const ownBase = db.from("voice_samples").select("id, body, source_label, created_at").order("created_at", { ascending: true });
      const { data: own, error: ownErr } = await (
        publicUserId ? ownBase.eq("user_id", publicUserId) : ownBase.is("user_id", null)
      );
      if (ownErr) return dbErrorResponse(ownErr);

      // Owners also see the house-style samples.
      let house: unknown[] = [];
      if (role === "tenant_owner") {
        const { data: houseRows, error: houseErr } = await db
          .from("voice_samples")
          .select("id, body, source_label, created_at")
          .is("user_id", null)
          .order("created_at", { ascending: true });
        if (houseErr) return dbErrorResponse(houseErr);
        house = houseRows ?? [];
      }

      // Load the extracted card (own, then house fallback).
      const cardBase = db.from("voice_profiles").select("style_card, card_override, extracted_at, samples_hash");
      const { data: card } = await (
        publicUserId ? cardBase.eq("user_id", publicUserId) : cardBase.is("user_id", null)
      ).maybeSingle();

      let houseCard = null;
      if (!card && role === "tenant_owner") {
        const { data: hc } = await db
          .from("voice_profiles").select("style_card, card_override, extracted_at")
          .is("user_id", null).maybeSingle();
        houseCard = hc;
      }

      return Response.json({
        own_samples: own ?? [],
        house_samples: house,
        profile: card ?? houseCard ?? null,
        is_owner: role === "tenant_owner",
      });
    }

    // No auth_user_id — structurally unreachable (assertPermission requires a session).
    return Response.json({ own_samples: [], house_samples: [], profile: null, is_owner: false });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "voice_profile",
      action: "write",
    });

    let body: { body?: string; source_label?: string; is_house_style?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const sampleBody = (body.body ?? "").trim();
    if (sampleBody.length < 50 || sampleBody.length > 8000) {
      return Response.json({ error: "body must be 50–8000 characters" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    const { data: urow, error: uErr } = await db
      .from("users").select("id, role").eq("auth_user_id", authUserId ?? "").maybeSingle();
    if (uErr) return dbErrorResponse(uErr);
    const publicUserId = (urow as { id: string } | null)?.id ?? null;
    const role = (urow as { role?: string } | null)?.role ?? "";

    // Only owners can add house-style samples.
    const isHouseStyle = body.is_house_style === true;
    if (isHouseStyle && role !== "tenant_owner") {
      return Response.json({ error: "only owners can add house-style samples" }, { status: 403 });
    }

    const targetUserId = isHouseStyle ? null : publicUserId;

    const { data: inserted, error: insErr } = await db
      .from("voice_samples")
      .insert({
        tenant_id: ctx.tenant_id,
        user_id: targetUserId,
        body: sampleBody,
        source_label: (body.source_label ?? "").trim().slice(0, 200),
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      return dbErrorResponse();
    }

    // Dispatch extraction event (event-driven, idle-free per D-192).
    await inngest.send({
      name: "voice_profile.extraction_requested",
      data: { tenant_id: ctx.tenant_id, user_id: targetUserId },
    });

    return Response.json({ id: (inserted as { id: string }).id }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
