// §27.12 — Operator-managed AI vendor pricing catalog.
//
// GET  returns the current effective catalog: AI_PRICING_DEFAULTS merged
//      with the platform_settings.ai_pricing_catalog override row.
//
// PUT  body { catalog: Record<model, { input_per_million_cents, output_per_million_cents }> }
//      replaces the override row. Validates each entry is a positive integer
//      cents/million value. Bumps ai_pricing_last_refreshed_at so the
//      dashboard's "last refreshed" indicator updates.
//
// Wrapped in withPlatformAdminAudit with reason='ai_pricing_update' so the
// before/after catalog is captured in audit_log.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { AI_PRICING_DEFAULTS, type ModelPricing } from "@/lib/ai/pricing";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface PutBody {
  catalog: Record<string, ModelPricing>;
}

function isValidPricing(p: unknown): p is ModelPricing {
  if (!p || typeof p !== "object") return false;
  const { input_per_million_cents, output_per_million_cents } = p as Record<string, unknown>;
  return (
    Number.isInteger(input_per_million_cents) &&
    (input_per_million_cents as number) >= 0 &&
    Number.isInteger(output_per_million_cents) &&
    (output_per_million_cents as number) >= 0
  );
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "ai_pricing")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "ai_pricing_read",
        operation: "ai_pricing_read",
        reason_detail: "operator viewing current pricing catalog",
      },
      async (db) => {
        const [{ data: catalogRow }, { data: refreshRow }] = await Promise.all([
          db.from("platform_settings").select("value").eq("key", "ai_pricing_catalog").maybeSingle(),
          db.from("platform_settings").select("value").eq("key", "ai_pricing_last_refreshed_at").maybeSingle(),
        ]);
        const override = (catalogRow?.value as Record<string, ModelPricing> | undefined) ?? {};
        const effective = { ...AI_PRICING_DEFAULTS, ...override };
        return {
          defaults: AI_PRICING_DEFAULTS,
          override,
          effective,
          last_refreshed_at: (refreshRow?.value as string | undefined) ?? null,
        };
      },
    );
    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function PUT(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "ai_pricing")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.catalog || typeof body.catalog !== "object") {
    return Response.json({ error: "catalog_required" }, { status: 400 });
  }
  const invalid = Object.entries(body.catalog).find(([, p]) => !isValidPricing(p));
  if (invalid) {
    return Response.json(
      { error: "invalid_pricing_entry", model: invalid[0] },
      { status: 400 },
    );
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "ai_pricing_update",
        operation: "ai_pricing_update",
        reason_detail: `models=${Object.keys(body.catalog).join(",")}`,
      },
      async (db) => {
        const now = new Date().toISOString();
        const { error: catalogErr } = await db
          .from("platform_settings")
          .upsert(
            {
              key: "ai_pricing_catalog",
              value: body.catalog,
              description: "§27.12 — operator-managed AI vendor pricing catalog (cents per million tokens).",
            },
            { onConflict: "key" },
          );
        if (catalogErr) {
          const ref = crypto.randomUUID();
          console.error("[db-error] ref=%s", ref, catalogErr);

          return { error: "db_error", ref };
        }

        await safeAwait(db
          .from("platform_settings")
          .upsert(
            {
              key: "ai_pricing_last_refreshed_at",
              value: now,
              description: "§27.12 — timestamp of last successful AI pricing cache refresh (manual or auto).",
            },
            { onConflict: "key" },
          ), "platform_settings.upsert");

        return { ok: true, last_refreshed_at: now, model_count: Object.keys(body.catalog).length };
      },
    );
    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
