// §16.4 — Verify a tenant's email_from_domain with Resend.
//
// POST /api/tenant/branding/email-domain/verify
//   No body. Reads tenant_branding.email_from_domain for the calling
//   tenant; registers it with Resend if not yet registered; polls Resend
//   for verification status; stamps email_from_domain_verified_at when
//   Resend reports `status: 'verified'`.
//
// Response:
//   { status: "verified" | "pending" | "failed",
//     dns_records: [{ record: "SPF", name, value, ... }, ...] }
//
// The endpoint is safe to call repeatedly. Resend's domains API is
// idempotent on the create call (returns existing object if the domain
// already exists for the account).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const RESEND_DOMAINS_URL = "https://api.resend.com/domains";

interface ResendDomain {
  id: string;
  name: string;
  status: "not_started" | "pending" | "verified" | "failed";
  records?: unknown[];
}

interface BrandingRow {
  email_from_domain: string | null;
  resend_domain_id: string | null;
  email_from_domain_dns_records: unknown[] | null;
  email_from_domain_verified_at: string | null;
}

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "tenant_branding", action: "write" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { ctx } = auth;
  const db = tenantClient(ctx);

  const { data: brandingRow, error: brandingErr } = await db
    .from("tenant_branding")
    .select("email_from_domain, resend_domain_id, email_from_domain_dns_records, email_from_domain_verified_at")
    .maybeSingle();
  if (brandingErr) return dbErrorResponse(brandingErr);
  const branding = (brandingRow ?? null) as BrandingRow | null;
  if (!branding?.email_from_domain) {
    return Response.json({ error: "no_email_from_domain_set" }, { status: 400 });
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "resend_not_configured" }, { status: 500 });
  }

  // Step 1: register the domain with Resend if we don't already have an id.
  // The Resend API returns the existing object on a duplicate create, so
  // calling create twice is safe — but storing the id locally avoids the
  // extra round-trip.
  let domainId = branding.resend_domain_id;
  let records: unknown[] | null = branding.email_from_domain_dns_records;

  if (!domainId) {
    const createRes = await fetch(RESEND_DOMAINS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: branding.email_from_domain }),
    });
    if (!createRes.ok) {
      const text = await createRes.text();
      return Response.json(
        { error: "resend_create_failed", status: createRes.status, detail: text.slice(0, 500) },
        { status: 502 },
      );
    }
    const created = (await createRes.json()) as ResendDomain;
    domainId = created.id;
    records = (created.records as unknown[]) ?? null;
    await safeAwait(
      db.from("tenant_branding")
        .update({
          resend_domain_id: domainId,
          email_from_domain_dns_records: records,
        })
        .eq("tenant_id", ctx.tenant_id),
      "tenant_branding.resend_domain_id",
    );
  }

  // Step 2: trigger Resend to verify. This re-checks DNS records and
  // updates the domain's status server-side. Cheap to call; no penalty
  // for calling when the tenant hasn't yet added the records.
  const verifyRes = await fetch(`${RESEND_DOMAINS_URL}/${domainId}/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!verifyRes.ok && verifyRes.status !== 200) {
    const text = await verifyRes.text();
    return Response.json(
      { error: "resend_verify_failed", status: verifyRes.status, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }

  // Step 3: read the current status (verify endpoint just triggers; we
  // need a GET to read the resulting state).
  const getRes = await fetch(`${RESEND_DOMAINS_URL}/${domainId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!getRes.ok) {
    const text = await getRes.text();
    return Response.json(
      { error: "resend_get_failed", status: getRes.status, detail: text.slice(0, 500) },
      { status: 502 },
    );
  }
  const domain = (await getRes.json()) as ResendDomain;
  const verifiedAt =
    domain.status === "verified" ? new Date().toISOString() : null;

  // Step 4: persist verification timestamp + refreshed DNS records.
  await safeAwait(
    db.from("tenant_branding")
      .update({
        email_from_domain_verified_at: verifiedAt,
        email_from_domain_dns_records: (domain.records as unknown[]) ?? records,
      })
      .eq("tenant_id", ctx.tenant_id),
    "tenant_branding.email_from_domain_verified_at",
  );

  return Response.json({
    status: domain.status,
    dns_records: (domain.records as unknown[]) ?? records ?? [],
    verified_at: verifiedAt,
  });
}

export async function GET(req: Request): Promise<Response> {
  // Read current verification state without triggering a Resend call.
  let auth;
  try {
    auth = await assertPermission(req, { resource: "tenant_branding", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const db = tenantClient(auth.ctx);

  const { data, error } = await db
    .from("tenant_branding")
    .select("email_from_domain, email_from_domain_verified_at, email_from_domain_dns_records, resend_domain_id")
    .maybeSingle();
  if (error) return dbErrorResponse(error);
  if (!data) return Response.json({ status: "not_configured" });

  const row = data as BrandingRow;
  return Response.json({
    domain: row.email_from_domain ?? null,
    status: row.email_from_domain_verified_at
      ? "verified"
      : row.resend_domain_id
        ? "pending"
        : "not_configured",
    verified_at: row.email_from_domain_verified_at,
    dns_records: row.email_from_domain_dns_records ?? [],
  });
}
