// §33.12 — List knowledge_chunks for the authority-override curation UI.
//
// Platform-admin only. Wrapped in withPlatformAdminAudit because the
// list is a cross-tenant read; the audit row records the operator's
// browsing activity for §26.11 quarterly review. Forwards to
// /api/admin/list-chunks-for-curation on the RAG side with a service
// JWT (service_identifier='platform-admin').

import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { assertPlatformRole, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformRole(req, ["superadmin", "reviewer", "service"])).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) {
    return Response.json({ error: "rag_service_not_configured" }, { status: 500 });
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "rag_authority_curation",
        operation: "list_chunks_for_curation",
      },
      async (_db, _recordQuery) => {
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
          return { error: "rag_list_failed", detail, status: res.status };
        }
        return await res.json();
      },
    );

    if (result && typeof result === "object" && "error" in result) {
      const r = result as { error: string; detail?: string; status?: number };
      return Response.json({ error: r.error, detail: r.detail }, { status: r.status ?? 500 });
    }
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "unexpected_error" },
      { status: 500 },
    );
  }
}
