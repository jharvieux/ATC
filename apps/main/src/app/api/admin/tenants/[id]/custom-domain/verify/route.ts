// §16.3.1 — Verify custom-domain DNS records and bind via Vercel.
// Both checks (CNAME + TXT) MUST pass within the same handler invocation.
// Only then is the Vercel API called.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { lookupCname, lookupTxt } from "@/lib/dns/doh-resolver";
import { vercelAddDomain, CrownJewelGuardError } from "@/lib/vercel/domain-client";
import { writeAuditLog } from "@/lib/audit/write";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "tenants")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { id: tenantId } = await params;

  const reservedParent = process.env.RESERVED_PARENT_DOMAIN ?? "tenants.ai-travelconcierge.com";

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "tenant_status_change",
        operation: "custom_domain.verify",
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "tenants" });
        const { data: tenant, error: fetchErr } = await db
          .from("tenants")
          .select("id, custom_domain, custom_domain_verification_token, custom_domain_status")
          .eq("id", tenantId)
          .single();

        if (fetchErr || !tenant) throw new Error("tenant_not_found");

        const t = tenant as {
          custom_domain: string | null;
          custom_domain_verification_token: string | null;
          custom_domain_status: string;
        };

        if (!t.custom_domain || !t.custom_domain_verification_token) {
          throw new Error("custom_domain_not_initiated");
        }

        // ── CNAME check ────────────────────────────────────────────────
        const cnameTarget = await lookupCname(t.custom_domain);
        if (!cnameTarget || cnameTarget !== reservedParent.toLowerCase()) {
          return {
            verified: false,
            error: "cname_mismatch",
            expected: reservedParent,
            actual: cnameTarget,
          };
        }

        // ── TXT check ──────────────────────────────────────────────────
        const txtValues = await lookupTxt(`_verify.${t.custom_domain}`);
        if (!txtValues.includes(t.custom_domain_verification_token)) {
          return {
            verified: false,
            error: "txt_mismatch",
            expected_value_present: false,
          };
        }

        // ── Both passed — bind via Vercel ──────────────────────────────
        // (CrownJewelGuardError is raised inside vercelAddDomain if PLATFORM_ENV != production.)
        await vercelAddDomain(t.custom_domain);

        recordQuery({ op: "update", table: "tenants" });
        await safeAwait(db
          .from("tenants")
          .update({
            custom_domain_verified_at: new Date().toISOString(),
            custom_domain_status: "verified",
            custom_domain_last_reverified_at: new Date().toISOString(),
          })
          .eq("id", tenantId), "tenants.update");

        return { verified: true, custom_domain: t.custom_domain };
      },
    );

    return Response.json(result);
  } catch (err) {
    if (err instanceof CrownJewelGuardError) {
      // §16.3.4 — log a security event when a non-production env attempts to bind.
      console.error("[crown-jewel-guard] BLOCKED Vercel binding attempt: %s", err.message);
      await writeAuditLog({
        tenant_id: tenantId,
        actor_user_id: adminUserId,
        actor_type: "admin",
        action: "security.crown_jewel_guard_blocked",
        resource_type: "tenant",
        resource_id: tenantId,
        changes: { error: err.message },
      });
      return Response.json({ error: "non_production_binding_refused" }, { status: 403 });
    }
    return dbErrorResponse(err);
  }
}
