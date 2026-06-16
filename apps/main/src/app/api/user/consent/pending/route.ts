// §17.4 — Returns the current user's pending consent obligations with document content.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ pending: [] });
  }
  const accessToken = authHeader.slice("Bearer ".length);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return Response.json({ pending: [] });
  }
  const authUserId = authData.user.id;

  const db = createServiceRoleClient();
  const { data: rows, error } = await db
    .from("user_consent_pending")
    .select("document_type, document_id_pending, flagged_at")
    .eq("auth_user_id", authUserId);

  if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

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
