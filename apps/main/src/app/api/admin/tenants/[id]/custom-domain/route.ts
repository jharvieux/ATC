// §16.3.1 — Initiate custom-domain setup.
// POST: tenant-admin requests binding for a subdomain.
// Returns the DNS records the tenant must add (CNAME + TXT verification token).

import crypto from "node:crypto";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface InitBody {
  custom_domain: string;
}

// Agency tiers that may use custom domains per §16.3 opening line / §3.3.
const AGENCY_TIERS = new Set(["sub_agency", "byo_agency"]);

function isValidSubdomain(d: string): boolean {
  // Must contain at least one dot (no apex), only [a-z0-9.-], length 4–253.
  if (!d || d.length < 4 || d.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(d)) return false;
  const labels = d.split(".");
  if (labels.length < 2) return false;
  // Reject apex registrations — must have a leading subdomain part.
  // e.g. "example.com" → reject; "travel.example.com" → accept.
  if (labels.length === 2) return false;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && !l.startsWith("-") && !l.endsWith("-"));
}

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

  let body: InitBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const customDomain = (body.custom_domain ?? "").trim().toLowerCase();
  if (!isValidSubdomain(customDomain)) {
    return Response.json(
      { error: "invalid_domain", message: "Subdomain required (no apex). Allowed: a-z, 0-9, '.', '-'." },
      { status: 422 },
    );
  }

  // Reject platform-owned hostnames.
  const platformPrimaryDomain = process.env.PLATFORM_PRIMARY_DOMAIN ?? "";
  const reservedParent = process.env.RESERVED_PARENT_DOMAIN ?? "tenants.ai-travelconcierge.com";
  if (
    customDomain === platformPrimaryDomain ||
    customDomain === reservedParent ||
    customDomain.endsWith(`.${platformPrimaryDomain}`) ||
    customDomain.endsWith(`.${reservedParent}`)
  ) {
    return Response.json({ error: "platform_owned_domain" }, { status: 422 });
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "tenant_status_change",
        operation: "custom_domain.initiate",
        reason_detail: customDomain,
      },
      async (db, recordQuery) => {
        // Verify tier eligibility.
        recordQuery({ op: "select", table: "tenants" });
        const { data: tenant, error: fetchErr } = await db
          .from("tenants")
          .select("id, tier_id, custom_domain")
          .eq("id", tenantId)
          .single();

        if (fetchErr || !tenant) throw new Error("tenant_not_found");

        const { data: tier } = await db
          .from("tier_definitions")
          .select("code")
          .eq("id", (tenant as { tier_id: string }).tier_id)
          .maybeSingle();

        if (!tier || !AGENCY_TIERS.has((tier as { code: string }).code)) {
          throw new Error("tier_not_eligible_for_custom_domain");
        }

        // Reject domain that already belongs to another tenant.
        recordQuery({ op: "select", table: "tenants" });
        const { data: collision } = await db
          .from("tenants")
          .select("id")
          .eq("custom_domain", customDomain)
          .neq("id", tenantId)
          .maybeSingle();

        if (collision) throw new Error("domain_already_claimed");

        // Generate verification token (URL-safe, 32 bytes → 43 chars base64url).
        const token = crypto.randomBytes(32).toString("base64url");

        recordQuery({ op: "update", table: "tenants" });
        const { error: updateErr } = await db
          .from("tenants")
          .update({
            custom_domain: customDomain,
            custom_domain_verification_token: token,
            custom_domain_status: "pending_verification",
          })
          .eq("id", tenantId);

        if (updateErr) throw new Error(updateErr.message);

        return {
          custom_domain: customDomain,
          dns_records: {
            cname: {
              host: customDomain,
              type: "CNAME",
              value: reservedParent,
            },
            txt: {
              host: `_verify.${customDomain}`,
              type: "TXT",
              value: token,
            },
          },
        };
      },
    );

    return Response.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "tier_not_eligible_for_custom_domain") {
      return Response.json({ error: msg }, { status: 403 });
    }
    if (msg === "domain_already_claimed") {
      return Response.json({ error: msg }, { status: 409 });
    }
    if (msg === "tenant_not_found") {
      return Response.json({ error: msg }, { status: 404 });
    }
    return dbErrorResponse(err);
  }
}
