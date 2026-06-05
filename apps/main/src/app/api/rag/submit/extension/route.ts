// §22.9 — Browser extension submission endpoint.
//
// The extension authenticates the user via the standard Supabase password
// flow (per docs/browser-extension.md). Once authenticated, the extension
// POSTs: { url, page_title, selection } with Authorization: Bearer <token>.
// CORS headers allow requests from chrome-extension:// origins.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createSubmission } from "@/lib/rag-ingest/create-submission";
import { respondToAuthError } from "@/lib/auth/respond";
import { corsOptionsResponse, EXTERNAL_CLIENT_CORS_HEADERS } from "@/lib/http/cors";

interface Body {
  url?: string;
  page_title?: string;
  selection: string;
}

export function OPTIONS(): Response {
  return corsOptionsResponse();
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "rag_submissions", action: "create" });
    const db = tenantClient(ctx);

    let body: Body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!body.selection || body.selection.trim().length === 0) {
      return Response.json({ error: "selection_required" }, { status: 400 });
    }

    const result = await createSubmission({
      db,
      tenant_id: ctx.tenant_id,
      submitted_by_user_id: user.id,
      submission_method: "browser_extension",
      source_url: body.url ?? null,
      source_title: body.page_title ?? null,
      original_content: body.selection,
    });

    return Response.json(result, { headers: EXTERNAL_CLIENT_CORS_HEADERS });
  } catch (err) {
    return respondToAuthError(err);
  }
}
