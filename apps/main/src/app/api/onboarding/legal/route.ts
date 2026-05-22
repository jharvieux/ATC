// §15.4 / §17.4 — Onboarding Stage 3: Legal document acceptance.
// Records consent for ToU, Privacy Policy, AI Disclaimer, Cookie Policy.
// legal_documents / legal_consents tables ship in Build Prompt 17.
// TODO(prompt-17): replace stubs with real legal_consents writes when §17 lands.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";

interface LegalAcceptBody {
  // List of document IDs (or types for stub) the user is accepting.
  accepted_types: string[];
  ip_address?: string;
  user_agent?: string;
}

const REQUIRED_DOCUMENT_TYPES = ["tou", "privacy_policy", "ai_disclaimer", "cookie_policy"];

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "legal:accept" });

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

    // TODO(prompt-17): write legal_consents rows per accepted document_type.
    // When §17 lands, replace this stub with:
    //   for each type in accepted_types:
    //     const doc = await fetchCurrentLegalDocument(type);
    //     await db.from('legal_consents').insert({ auth_user_id, tenant_id, document_id, ... })
    console.info("[onboarding/legal] Stub consent recorded for tenant=%s types=%o", ctx.tenant_id, body.accepted_types);

    await progressTo(ctx.tenant_id, "ica");

    return Response.json({ ok: true, next_stage: "ica" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
