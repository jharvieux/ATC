// §17.4 — Consent renewal endpoint.
// POST: accept a pending document version for the authenticated user.
// Inserts a legal_consents row and removes the user_consent_pending row.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

interface ConsentBody {
  document_type: string;
}

const VALID_TYPES = [
  "tou", "privacy_policy", "ai_disclaimer", "cookie_policy",
  "ica_subhost", "can_spam_addendum", "tcpa_addendum",
];

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
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
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUserId = authData.user.id;

  let body: ConsentBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!VALID_TYPES.includes(body.document_type)) {
    return Response.json({ error: "invalid_document_type" }, { status: 422 });
  }

  const db = createServiceRoleClient();

  // Find the pending row for this user + document type.
  const { data: pending, error: pendingErr } = await db
    .from("user_consent_pending")
    .select("document_id_pending, document_type")
    .eq("auth_user_id", authUserId)
    .eq("document_type", body.document_type)
    .maybeSingle();

  if (pendingErr) return Response.json({ error: pendingErr.message }, { status: 500 });
  if (!pending) return Response.json({ error: "no_pending_consent_for_type" }, { status: 404 });

  const typedPending = pending as { document_id_pending: string; document_type: string };

  // Fetch the document version.
  const { data: doc, error: docErr } = await db
    .from("legal_documents")
    .select("id, version")
    .eq("id", typedPending.document_id_pending)
    .single();

  if (docErr || !doc) return Response.json({ error: "document_not_found" }, { status: 404 });

  const typedDoc = doc as { id: string; version: number };

  // For tenant-scoped documents (ica_subhost), capture tenant_id from middleware header.
  const tenantId = body.document_type === "ica_subhost"
    ? (req.headers.get("x-resolved-tenant-id") ?? null)
    : null;

  const { error: insertErr } = await db.from("legal_consents").insert({
    auth_user_id: authUserId,
    ...(tenantId ? { tenant_id: tenantId } : {}),
    document_id: typedDoc.id,
    document_type: body.document_type,
    document_version: typedDoc.version,
    action: "accepted",
    ip_address: req.headers.get("x-forwarded-for") ?? "unknown",
    user_agent: req.headers.get("user-agent") ?? "",
  });

  if (insertErr) return Response.json({ error: insertErr.message }, { status: 500 });

  // Remove the pending row now that consent is recorded.
  await safeAwait(db
    .from("user_consent_pending")
    .delete()
    .eq("auth_user_id", authUserId)
    .eq("document_type", body.document_type), "user_consent_pending.delete");

  return Response.json({ ok: true, document_type: body.document_type });
}
