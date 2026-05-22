// §22.1 — Web UI single-item submission.
// Also serves §22.1 manual-entry (same shape, different prompt label).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createSubmission, type SubmissionMethod } from "@/lib/rag-ingest/create-submission";

interface Body {
  content: string;
  source_url?: string;
  source_title?: string;
  category_hint?: string;
  // Differentiates 'web_ui' vs 'manual_entry' UX label; both flow identically.
  via?: "web_ui" | "manual_entry";
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

    if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
      return Response.json({ error: "content_required" }, { status: 400 });
    }

    const method: SubmissionMethod = body.via === "manual_entry" ? "manual_entry" : "web_ui";

    const result = await createSubmission({
      db,
      tenant_id: ctx.tenant_id,
      submitted_by_user_id: user.id,
      submission_method: method,
      source_url: body.source_url ?? null,
      source_title: body.source_title ?? null,
      original_content: body.content,
    });

    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
