// §33.12 — Set authority manual override for a knowledge_chunk.
//
// Platform-admin only. Forwards to RAG /api/admin/set-authority-override
// with a service JWT (service_identifier='platform-admin').
//
// Body: { authority_manual_override: number | null, reason: string }
//   - number in [0, 1] sets the override (matches the §6.3 authority scale)
//   - null clears the override and reverts to authority_auto
//   - reason is required when setting (not when clearing)

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface Body {
  authority_manual_override: number | null;
  reason: string;
  // The RAG knowledge_chunks table is global-scoped — origin tenant lives
  // on the row itself. Caller may include this for the audit row but it's
  // not strictly required; the RAG endpoint doesn't use it.
  origin_tenant_id?: string;
}

interface RagResponse {
  ok?: boolean;
  chunk?: unknown;
  error?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ chunk_id: string }> },
): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "rag")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { chunk_id } = await params;
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) {
    return Response.json({ error: "rag_service_not_configured" }, { status: 500 });
  }

  const operation =
    body.authority_manual_override === null
      ? "rag_authority_override_clear"
      : "rag_authority_override_set";

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "rag_authority_curation",
        operation,
      },
      async (_db, _recordQuery) => {
        // Service JWT — RAG's withServiceAuth allows scoped writes when
        // service_identifier='platform-admin'. The tenant_id field is
        // required by the JWT shape but the endpoint itself is global-
        // scoped; we pass the origin tenant for audit trail.
        const jwt = await signServiceJwt({
          tenant_id: body.origin_tenant_id ?? "00000000-0000-0000-0000-000000000000",
          scope: "write",
          service_identifier: "platform-admin",
        });

        const res = await fetch(
          `${ragUrl}/api/admin/set-authority-override?id=${encodeURIComponent(chunk_id)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              authority_manual_override: body.authority_manual_override,
              reason: body.reason ?? "",
            }),
          },
        );

        if (!res.ok) {
          const detail = await res.text();
          return {
            ok: false,
            status: res.status,
            detail,
          };
        }
        return (await res.json()) as RagResponse;
      },
    );

    if (!result || (result as { ok?: boolean }).ok === false) {
      const r = result as { status?: number; detail?: string };
      return Response.json(
        { error: "rag_override_failed", detail: r.detail ?? "unknown" },
        { status: r.status ?? 500 },
      );
    }

    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
