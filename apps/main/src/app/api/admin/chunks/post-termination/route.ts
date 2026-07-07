// §15.14.4 — Post-termination chunk review queue API.
// GET: list globally-promoted chunks pending review (post_termination_review_status='pending').
// POST: take an action on a chunk (retain | demote | hard_delete).
// All actions write to audit_log via withPlatformAdminAudit.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface ReviewActionBody {
  chunk_id: string;
  action: "retain" | "demote" | "hard_delete";
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "chunks")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = 20;
  const from = (page - 1) * pageSize;

  const ragServiceUrl = process.env.RAG_SERVICE_URL;
  if (!ragServiceUrl) return Response.json({ error: "rag_service_not_configured" }, { status: 500 });

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "rag_quarantined_content_review", operation: "post_termination_queue.list" },
      async (_db, recordQuery) => {
        recordQuery({ op: "select", table: "knowledge_chunks (rag-side)" });

        // BP09 — RS256 JWT, PLATFORM sentinel (cross-tenant: queue lists
        // chunks from ALL terminated tenants).
        const jwt = await signServiceJwt({
          tenant_id: PLATFORM_SENTINEL_TENANT_ID,
          scope: "read",
          service_identifier: "platform-admin",
        });

        const res = await fetch(
          `${ragServiceUrl}/api/admin/post-termination-queue?from=${from}&limit=${pageSize}`,
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${jwt}`,
            },
          },
        );

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`RAG service error: ${res.status} ${text}`);
        }

        return res.json();
      },
    );

    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "chunks")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: ReviewActionBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!["retain", "demote", "hard_delete"].includes(body.action)) {
    return Response.json({ error: "invalid_action" }, { status: 422 });
  }

  if (!body.chunk_id) {
    return Response.json({ error: "chunk_id required" }, { status: 422 });
  }

  const ragServiceUrl = process.env.RAG_SERVICE_URL;
  if (!ragServiceUrl) return Response.json({ error: "rag_service_not_configured" }, { status: 500 });

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "rag_quarantined_content_review",
        operation: `post_termination_review.${body.action}`,
      },
      async (_db, recordQuery) => {
        recordQuery({ op: "update", table: "knowledge_chunks (rag-side)" });

        // BP09 — RS256 JWT, PLATFORM sentinel (cross-tenant operation).
        const jwt = await signServiceJwt({
          tenant_id: PLATFORM_SENTINEL_TENANT_ID,
          scope: "write",
          service_identifier: "platform-admin",
        });

        const res = await fetch(`${ragServiceUrl}/api/admin/post-termination-review`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({ chunk_id: body.chunk_id, action: body.action }),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`RAG service error: ${res.status} ${text}`);
        }

        return res.json();
      },
    );

    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
