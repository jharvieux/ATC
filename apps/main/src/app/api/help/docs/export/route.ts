// BP31 §32.6.1 / §32.3.3 — Trigger PDF or Word export of all help docs.
//
// Body: { format: 'pdf'|'docx' }
// Returns: { job_id }
//
// Cache lookup happens here first: if a fresh cache row exists for
// (code_version, tenant_id, format), return a synthetic job_id pointing
// at the cached storage_path so the poll endpoint can short-circuit
// without spinning up the Inngest worker.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const VALID_FORMATS = new Set(["pdf", "docx"]);

function codeVersion(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "dev"
  );
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "help_docs", action: "export" });
    const body = (await req.json().catch(() => ({}))) as { format?: string };
    if (!body.format || !VALID_FORMATS.has(body.format)) {
      return Response.json({ error: "invalid_format", message: "format must be 'pdf' or 'docx'" }, { status: 400 });
    }
    const format = body.format as "pdf" | "docx";

    const db = tenantClient(ctx);
    const cv = codeVersion();

    // Cache lookup — if a fresh row exists, the poll endpoint returns it directly.
    const { data: cached } = await db
      .from("help_doc_versions")
      .select("id, storage_path, expires_at")
      .eq("code_version", cv)
      .eq("tenant_id", ctx.tenant_id)
      .eq("format", format)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (cached) {
      // Use the cache-row id as the "job id" — the poll endpoint reads
      // the row and returns the signed URL. No Inngest dispatch needed.
      return Response.json({ job_id: (cached as { id: string }).id, cached: true });
    }

    // Cache miss — dispatch the Inngest export function and return a
    // synthetic job_id that the poll endpoint can use to find the
    // help_doc_versions row once the worker UPSERTs it.
    // We pre-create a placeholder row so the poll endpoint has something
    // to look up; the worker will UPSERT and fill storage_path + expires_at.
    const placeholderExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // 24h placeholder
    const { data: placeholder, error: insertErr } = await db
      .from("help_doc_versions")
      .insert({
        code_version: cv,
        tenant_id: ctx.tenant_id,
        format,
        storage_path: "", // worker fills
        expires_at: placeholderExpiresAt,
      })
      .select("id")
      .single();
    if (insertErr || !placeholder) {
      return dbErrorResponse(insertErr);
    }
    const job_id = (placeholder as { id: string }).id;

    await inngest.send({
      name: format === "pdf" ? "help/docs.export.pdf" : "help/docs.export.docx",
      data: {
        tenant_id: ctx.tenant_id,
        job_id,
        code_version: cv,
      },
    });

    return Response.json({ job_id, cached: false });
  } catch (err) {
    return respondToAuthError(err);
  }
}
