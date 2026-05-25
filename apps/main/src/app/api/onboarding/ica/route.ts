// §15.5 — Onboarding Stage 4: ICA acceptance.
// Requires scroll-to-bottom confirmation + typed legal name.
// legal_documents / legal_consents from §17.4 are TODO(prompt-17).
// ICA chunk-license-survival clause text is TODO(legal-attorney) per §15.14.6.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";
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
    const { data: tenant } = await db
      .from("tenants")
      .select("legal_name")
      .eq("id", ctx.tenant_id)
      .single();

    if (!tenant?.legal_name) {
      return Response.json({ error: "complete_profile_first" }, { status: 409 });
    }

    // Case-insensitive, whitespace-trimmed comparison per §15.5.
    const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized(body.typed_legal_name) !== normalized(tenant.legal_name)) {
      return Response.json({ error: "name_mismatch" }, { status: 422 });
    }

    // TODO(prompt-17): write legal_consents row for 'ica_subhost' document with
    //   notes = typed_legal_name, ip captured server-side.
    const { error } = await db
      .from("tenants")
      .update({ ica_accepted_at: new Date().toISOString() })
      .eq("id", ctx.tenant_id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    console.info("[onboarding/ica] ICA accepted tenant=%s user=%s", ctx.tenant_id, user.id);

    await progressTo(ctx.tenant_id, "tax_form");

    return Response.json({ ok: true, next_stage: "tax_form" });
  } catch (err) {
    return respondToAuthError(err);
  }
}
