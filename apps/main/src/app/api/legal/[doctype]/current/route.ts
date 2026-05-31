// §7.1 (route table) / §17.4 — Get current legal document.
// Returns the non-superseded version of the requested document type.
// Any authenticated user may read legal documents (RLS: auth.uid() IS NOT NULL).

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";

const VALID_TYPES = [
  "tou", "privacy_policy", "ai_disclaimer", "cookie_policy",
  "ica_subhost", "can_spam_addendum", "tcpa_addendum",
];

export async function GET(
  req: Request,
  { params }: { params: Promise<{ doctype: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "legal_document", action: "read" });
    const { doctype } = await params;

    if (!VALID_TYPES.includes(doctype)) {
      return Response.json({ error: "invalid_document_type" }, { status: 422 });
    }

    const db = tenantClient(ctx);
    const { data: docs, error } = await db
      .from("legal_documents")
      .select("id, document_type, version, content_markdown, content_html, effective_at")
      .eq("document_type", doctype)
      .is("superseded_at", null)
      .limit(2);

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!docs || docs.length === 0) {
      return Response.json({ error: "document_not_found" }, { status: 404 });
    }
    if (docs.length > 1) {
      // Schema invariant violation: two non-superseded versions exist.
      console.error("[legal/current] multiple current versions for %s", doctype);
      return Response.json({ error: "document_state_inconsistent" }, { status: 500 });
    }

    return Response.json(docs[0]);
  } catch (err) {
    return respondToAuthError(err);
  }
}
