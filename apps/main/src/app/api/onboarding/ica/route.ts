// §15.5 — Onboarding Stage 4: ICA acceptance.
// Requires scroll-to-bottom confirmation + typed legal name.
// Writes a legal_consents row for the ica_subhost document via service_role
// (authenticated users cannot INSERT per RLS).

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

interface IcaAcceptBody {
  typed_legal_name: string;
  scrolled_to_bottom: boolean;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "onboarding", action: "ica:accept" });

    let body: IcaAcceptBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.scrolled_to_bottom) {
      return Response.json({ error: "must_scroll_to_bottom" }, { status: 422 });
    }

    if (!body.typed_legal_name?.trim()) {
      return Response.json({ error: "typed_legal_name_required" }, { status: 422 });
    }

    const db = tenantClient(ctx);
    const { data: tenant, error: tenantErr } = await db
      .from("tenants")
      .select("legal_name")
      .eq("id", ctx.tenant_id)
      .single();

    if (tenantErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    if (!tenant?.legal_name) {
      return Response.json({ error: "complete_profile_first" }, { status: 409 });
    }

    // Case-insensitive, whitespace-trimmed comparison per §15.5.
    const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized(body.typed_legal_name) !== normalized(tenant.legal_name)) {
      return Response.json({ error: "name_mismatch" }, { status: 422 });
    }

    const { data: icaDocs, error: icaDocsErr } = await db
      .from("legal_documents")
      .select("id, version")
      .eq("document_type", "ica_subhost")
      .is("superseded_at", null)
      .limit(2);

    if (icaDocsErr) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }
    if (!icaDocs || icaDocs.length === 0) {
      return Response.json({ error: "ica_document_not_found" }, { status: 500 });
    }
    if (icaDocs.length > 1) {
      console.error("[onboarding/ica] multiple current ica_subhost versions for tenant=%s", ctx.tenant_id);
      return Response.json({ error: "document_state_inconsistent" }, { status: 500 });
    }

    const icaDoc = icaDocs[0] as { id: string; version: number };
    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";

    // service_role required: authenticated users cannot INSERT legal_consents per RLS.
    const serviceDb = createServiceRoleClient();

    const { error: consentErr } = await serviceDb.from("legal_consents").insert({
      auth_user_id: user.auth_user_id,
      tenant_id: ctx.tenant_id,
      document_id: icaDoc.id,
      document_type: "ica_subhost",
      document_version: icaDoc.version,
      action: "accepted",
      ip_address: ipAddress,
      user_agent: req.headers.get("user-agent") ?? "",
      notes: body.typed_legal_name.trim(),
    });

    if (consentErr && !consentErr.code?.includes("23505")) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }

    const { error } = await serviceDb
      .from("tenants")
      .update({ ica_accepted_at: new Date().toISOString() })
      .eq("id", ctx.tenant_id);

    if (error) {
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }

    console.info("[onboarding/ica] ICA accepted tenant=%s user=%s", ctx.tenant_id, user.id);

    await progressTo(ctx.tenant_id, "tax_form");

    return Response.json({ ok: true, next_stage: "tax_form" });
  } catch (err) {
    return respondToAuthError(err);
  }
}
