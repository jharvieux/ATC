// §33.12 — List knowledge_chunks for the authority-override curation UI.
//
// Platform-admin only. Forwards to RAG /api/admin/list-chunks-for-curation
// with a service JWT (service_identifier='platform-admin'). Query
// parameters are forwarded as-is so filters work end-to-end.

import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function GET(req: Request): Promise<Response> {
  try {
    await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) {
    return Response.json({ error: "rag_service_not_configured" }, { status: 500 });
  }

  const incoming = new URL(req.url);
  const forwarded = new URL(`${ragUrl}/api/admin/list-chunks-for-curation`);
  for (const [k, v] of incoming.searchParams) {
    forwarded.searchParams.set(k, v);
  }

  const jwt = await signServiceJwt({
    tenant_id: "00000000-0000-0000-0000-000000000000",
    scope: "read",
    service_identifier: "platform-admin",
  });

  const res = await fetch(forwarded.toString(), {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    return Response.json({ error: "rag_list_failed", detail }, { status: res.status });
  }
  const body = await res.json();
  return Response.json(body);
}
