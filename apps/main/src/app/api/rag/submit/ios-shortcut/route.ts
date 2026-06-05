// §22.10 — iOS Shortcut submission endpoint.
//
// Accepts either text (Content-Type: application/json with { text, url? })
// or a file (multipart/form-data with field 'file', identical to the
// /api/rag/submit/file flow). Auth via Authorization: Bearer <token>.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createSubmission } from "@/lib/rag-ingest/create-submission";
import { respondToAuthError } from "@/lib/auth/respond";
import { corsOptionsResponse, EXTERNAL_CLIENT_CORS_HEADERS } from "@/lib/http/cors";

interface TextBody {
  text: string;
  url?: string;
  title?: string;
}

export function OPTIONS(): Response {
  return corsOptionsResponse();
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "create" });
    const db = tenantClient(ctx);

    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.startsWith("multipart/form-data")) {
      // Delegate to the file route's shape — we accept the same form key.
      // Rather than re-implementing storage upload here, return 307 so the
      // client uploads to /api/rag/submit/file directly. The Shortcut definition
      // (in docs/ios-shortcut.md) handles the redirect transparently.
      return Response.json(
        { hint: "multipart_uploads_should_post_to_file_endpoint" },
        { status: 307, headers: { Location: "/api/rag/submit/file" } },
      );
    }

    let body: TextBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.text || body.text.trim().length === 0) {
      return Response.json({ error: "text_required" }, { status: 400 });
    }

    const result = await createSubmission({
      db,
      tenant_id: ctx.tenant_id,
      submitted_by_user_id: user.id,
      submission_method: "ios_shortcut",
      source_url: body.url ?? null,
      source_title: body.title ?? null,
      original_content: body.text,
    });

    return Response.json(result, { headers: EXTERNAL_CLIENT_CORS_HEADERS });
  } catch (err) {
    return respondToAuthError(err);
  }
}
