// §17.4 — Consent renewal endpoint.
// POST: accept a pending document version for the authenticated user.
// Inserts a legal_consents row and removes the user_consent_pending row.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

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

  // Find the pending row for this user + document type. The schema's
  // UNIQUE (auth_user_id, document_type) constraint means at most one
  // row matches; explicit .limit(1) + length check makes the contract
  // load-bearing in code (D-091 Round-3 Pattern 18 — `maybeSingle()`
  // returns null on either 0 OR >1 matches, silently failing if the
  // schema invariant is ever dropped).
  const { data: pendingRows, error: pendingErr } = await db
    .from("user_consent_pending")
    .select("document_id_pending, document_type")
    .eq("auth_user_id", authUserId)
    .eq("document_type", body.document_type)
    .limit(2);

  if (pendingErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
  if (!pendingRows || pendingRows.length === 0) {
    return Response.json({ error: "no_pending_consent_for_type" }, { status: 404 });
  }
  if (pendingRows.length > 1) {
    console.error(
      "[user/consent] schema invariant violated: %d pending rows for auth_user_id=%s document_type=%s",
      pendingRows.length, authUserId, body.document_type,
    );
    return Response.json({ error: "consent_state_inconsistent" }, { status: 500 });
  }

  const typedPending = pendingRows[0] as { document_id_pending: string; document_type: string };

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
    ? (req.headers.get(RESOLVED_TENANT_ID_HEADER) ?? null)
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

  if (insertErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

  // Remove the pending row now that consent is recorded.
  await safeAwait(db
    .from("user_consent_pending")
    .delete()
    .eq("auth_user_id", authUserId)
    .eq("document_type", body.document_type), "user_consent_pending.delete");

  return Response.json({ ok: true, document_type: body.document_type });
}
