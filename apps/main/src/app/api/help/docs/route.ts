// BP31 §32.6.1 — List help-doc sections.
//
// §32.3 tier-aware filtering: each tenant sees only docs whose frontmatter
// `tiers:` list includes their current tier code. Docs without a `tiers:`
// field are treated as universal (visible to every tier) — this is
// intentional so adding a new tier code doesn't accidentally hide existing
// content. See lib/help-ai/docs-loader.ts.

export const dynamic = "force-dynamic";

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { listDocs, listDocsForTier } from "@/lib/help-ai/docs-loader";

async function resolveTenantTierCode(
  ctx: { tenant_id: string },
): Promise<string | null> {
  try {
    const db = tenantClient(ctx);
    const { data: tenant } = await db
      .from("tenants")
      .select("tier_id")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    const tierId = (tenant as { tier_id: string | null } | null)?.tier_id;
    if (!tierId) return null;
    const { data: tier } = await db
      .from("tier_definitions")
      .select("code")
      .eq("id", tierId)
      .maybeSingle();
    return (tier as { code: string } | null)?.code ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "help_docs", action: "read" });
    const tierCode = await resolveTenantTierCode(ctx);
    // Fall back to listDocs() (universal view) if we can't determine the
    // tier — better to show too many than to hide everything on a config
    // glitch.
    const items = tierCode ? listDocsForTier(tierCode) : listDocs();
    return Response.json({ items, tier_code: tierCode });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}
