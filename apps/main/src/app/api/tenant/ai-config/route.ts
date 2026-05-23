// §9.10 — Tenant AI configuration API
// GET  /api/tenant/ai-config — current ai_mode, background_ai_enabled, resolved flags
// PATCH /api/tenant/ai-config — update ai_mode and/or background_ai_enabled

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { resolveAIBehavior, type AIMode } from "@/lib/personas/resolve-ai-behavior";
import { writeAuditLog } from "@/lib/audit/write";

// Cost range strings per §9.10.2 — real values land when §27.12 cost attribution lands
// TODO(§27.12-cost-display): replace with real cost attribution data
const COST_RANGES: Record<AIMode, string> = {
  autonomous: "varies based on usage",
  draft_only: "varies based on usage",
  disabled: "varies based on usage",
};

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "tenant.ai-config", action: "read" });

    // tenants is not in TENANT_SCOPED_TABLES so no auto-filter; scope manually
    const db = tenantClient(ctx);
    const { data: tenant, error } = await db
      .from("tenants")
      .select("ai_mode, background_ai_enabled")
      .eq("id", ctx.tenant_id)
      .single();

    if (error || !tenant) {
      return Response.json({ error: "tenant_not_found" }, { status: 404 });
    }

    const ai_mode = (tenant.ai_mode as AIMode) ?? "autonomous";
    const background_ai_enabled = tenant.background_ai_enabled ?? true;
    const flags = resolveAIBehavior({ ai_mode, background_ai_enabled });

    return Response.json({
      ai_mode,
      background_ai_enabled,
      flags,
      cost_ranges: COST_RANGES,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "tenant.ai-config",
      action: "tenant.config.update",
    });

    let body: { ai_mode?: string; background_ai_enabled?: boolean };
    try {
      body = await req.json() as typeof body;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const validModes = new Set(["autonomous", "draft_only", "disabled"]);
    if (body.ai_mode !== undefined && !validModes.has(body.ai_mode)) {
      return Response.json(
        { error: "invalid ai_mode — must be autonomous, draft_only, or disabled" },
        { status: 422 },
      );
    }
    if (body.background_ai_enabled !== undefined && typeof body.background_ai_enabled !== "boolean") {
      return Response.json(
        { error: "background_ai_enabled must be a boolean" },
        { status: 422 },
      );
    }

    // tenants not in TENANT_SCOPED_TABLES — scope manually with .eq("id", ...)
    const db = tenantClient(ctx);

    // Read before-state for audit log
    const { data: before } = await db
      .from("tenants")
      .select("ai_mode, background_ai_enabled")
      .eq("id", ctx.tenant_id)
      .single();

    const updates: Record<string, unknown> = {};
    if (body.ai_mode !== undefined) updates.ai_mode = body.ai_mode;
    if (body.background_ai_enabled !== undefined)
      updates.background_ai_enabled = body.background_ai_enabled;

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "no fields to update" }, { status: 422 });
    }

    const { data: after, error } = await db
      .from("tenants")
      .update(updates)
      .eq("id", ctx.tenant_id)
      .select("ai_mode, background_ai_enabled")
      .single();

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: ctx.source.kind === "http_request" ? ctx.source.user_id : null,
      actor_type: "user",
      action: "tenant.ai-config.updated",
      resource_type: "tenant",
      resource_id: ctx.tenant_id,
      changes: { before, after },
    });

    const ai_mode = (after.ai_mode as AIMode) ?? "autonomous";
    const background_ai_enabled = after.background_ai_enabled ?? true;

    return Response.json({
      ai_mode,
      background_ai_enabled,
      flags: resolveAIBehavior({ ai_mode, background_ai_enabled }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
