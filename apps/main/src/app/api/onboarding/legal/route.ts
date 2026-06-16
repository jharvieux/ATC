// §15.4 / §17.4 — Onboarding Stage 3: Legal document acceptance.
// Writes legal_consents rows via service_role — authenticated users cannot INSERT per RLS.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface LegalAcceptBody {
  accepted_types: string[];
}

const REQUIRED_DOCUMENT_TYPES = ["tou", "privacy_policy", "ai_disclaimer", "cookie_policy"];

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "onboarding", action: "legal:accept" });

    let body: LegalAcceptBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const accepted = new Set(body.accepted_types ?? []);
    const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !accepted.has(t));
    if (missing.length > 0) {
      return Response.json({ error: "missing_consents", missing }, { status: 422 });
    }

    const readDb = tenantClient(ctx);
    const { data: docs, error: docsErr } = await readDb
      .from("legal_documents")
      .select("id, document_type, version")
      .in("document_type", REQUIRED_DOCUMENT_TYPES)
      .is("superseded_at", null);

    if (docsErr) {
      return dbErrorResponse(docsErr);
    }
    if (!docs || docs.length === 0) {
      return Response.json({ error: "legal_documents_not_found" }, { status: 500 });
    }

    const docMap = new Map<string, { id: string; version: number }>(
      (docs as { id: string; document_type: string; version: number }[])
        .map((d) => [d.document_type, { id: d.id, version: d.version }]),
    );

    const missingDocs = REQUIRED_DOCUMENT_TYPES.filter((t) => !docMap.has(t));
    if (missingDocs.length > 0) {
      return Response.json({ error: "legal_documents_not_found", missing: missingDocs }, { status: 500 });
    }

    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
    const userAgent = req.headers.get("user-agent") ?? "";

    // Write consent rows via service_role — authenticated users cannot INSERT per RLS.
    const serviceDb = createServiceRoleClient();
    const consentRows = REQUIRED_DOCUMENT_TYPES.map((docType) => {
      const doc = docMap.get(docType)!;
      return {
        auth_user_id: user.auth_user_id,
        tenant_id: ctx.tenant_id,
        document_id: doc.id,
        document_type: docType,
        document_version: doc.version,
        action: "accepted" as const,
        ip_address: ipAddress,
        user_agent: userAgent,
      };
    });

    const { error: insertErr } = await serviceDb
      .from("legal_consents")
      .insert(consentRows);

    if (insertErr) {
      // 23505 = unique violation: user already accepted this version — idempotent.
      if (!insertErr.code?.includes("23505")) {
        return dbErrorResponse(insertErr);
      }
    }

    // BYO hosts skip ica + tax_form (sub-host-only steps).
    const { data: tenantRow, error: tenantErr } = await readDb
      .from("tenants")
      .select("tenant_type")
      .eq("id", ctx.tenant_id)
      .single();
    if (tenantErr) return dbErrorResponse(tenantErr);
    const nextStageName = tenantRow?.tenant_type === "byo_host" ? "state_of_operation" : "ica";

    await progressTo(ctx.tenant_id, nextStageName);

    return Response.json({ ok: true, next_stage: nextStageName });
  } catch (err) {
    return respondToAuthError(err);
  }
}
