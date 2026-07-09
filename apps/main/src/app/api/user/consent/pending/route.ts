// §17.4 — Returns the current user's pending consent obligations with document content.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { authenticateUser } from "@/lib/auth/authenticate-user";

export async function GET(req: Request): Promise<Response> {
  // #1591 — was `return { pending: [] }` on missing/invalid auth (silent 200),
  // out of step with the 401 the other four user-self routes return. An
  // unauthenticated caller now gets a consistent 401; the authenticated consent
  // page (which sends its session cookie) gets its real pending list.
  const authed = await authenticateUser(req);
  if (!authed) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUserId = authed.authUserId;

  // Isolation (#1703 audit): this handler uses createServiceRoleClient(), which
  // BYPASSES RLS (auth.uid() is NULL), so the verified auth_user_id .eq() filter
  // below is the SOLE enforced isolation layer. Any `auth_user_id = auth.uid()`
  // RLS policy is defense-in-depth for non-service-role paths only.
  const db = createServiceRoleClient();
  const { data: rows, error } = await db
    .from("user_consent_pending")
    .select("document_type, document_id_pending, flagged_at")
    .eq("auth_user_id", authUserId);

  if (error) return dbErrorResponse(error);

  if (!rows || rows.length === 0) {
    return Response.json({ pending: [] });
  }

  // Fetch document content for each pending doc.
  const docIds = (rows as { document_id_pending: string }[]).map((r) => r.document_id_pending);
  const { data: docs } = await db
    .from("legal_documents")
    .select("id, document_type, version, content_markdown")
    .in("id", docIds);

  const docMap: Record<string, { version: number; content_markdown: string }> = {};
  for (const doc of (docs ?? []) as { id: string; version: number; content_markdown: string }[]) {
    docMap[doc.id] = { version: doc.version, content_markdown: doc.content_markdown };
  }

  const pending = (rows as { document_type: string; document_id_pending: string; flagged_at: string }[]).map((r) => ({
    document_type: r.document_type,
    document_id_pending: r.document_id_pending,
    flagged_at: r.flagged_at,
    version: docMap[r.document_id_pending]?.version,
    content_markdown: docMap[r.document_id_pending]?.content_markdown,
  }));

  return Response.json({ pending });
}
