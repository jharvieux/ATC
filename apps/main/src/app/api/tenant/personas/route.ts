// §9.1 — GET /api/tenant/personas
// Returns the six base personas merged with any tenant-specific overrides.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { personaBase as marcus } from "@/lib/personas/base-blocks/marcus";
import { personaBase as marco } from "@/lib/personas/base-blocks/marco";
import { personaBase as priya } from "@/lib/personas/base-blocks/priya";
import { personaBase as dave } from "@/lib/personas/base-blocks/dave";
import { personaBase as maya } from "@/lib/personas/base-blocks/maya";
import { personaBase as jenny } from "@/lib/personas/base-blocks/jenny";
import { respondToAuthError } from "@/lib/auth/respond";

const BASE_PERSONAS = [marcus, marco, priya, dave, maya, jenny];

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "tenant.personas", action: "read" });

    // tenant_persona_overrides is in TENANT_SCOPED_TABLES — auto-scoped by tenantClient
    const db = tenantClient(ctx);
    const { data: overrides } = await db
      .from("tenant_persona_overrides")
      .select("persona_slug, display_name_override, system_prompt_addendum, is_disabled")
      .eq("tenant_id", ctx.tenant_id);

    const overrideMap = new Map(
      (overrides ?? []).map((o) => [o.persona_slug, o]),
    );

    const personas = BASE_PERSONAS.map((base) => {
      const override = overrideMap.get(base.slug);
      return {
        slug: base.slug,
        display_name: override?.display_name_override ?? base.display_name,
        specialty: base.specialty,
        tagline: base.tagline,
        is_disabled: override?.is_disabled ?? false,
        has_custom_addendum: !!(override?.system_prompt_addendum),
      };
    });

    return Response.json({ personas });
  } catch (err) {
    return respondToAuthError(err);
  }
}
