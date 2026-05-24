/**
 * BP31 §32.3.3 — Help docs PDF export Inngest function.
 *
 * **PDF binary generation via Puppeteer is deferred** — Puppeteer ships
 * ~200MB of Chromium and the operator hasn't approved the install yet.
 * In the interim this function generates the **HTML representation** of
 * the concatenated docs and uploads it as `{job_id}.html` to the
 * `help-docs` Supabase Storage bucket. The signed-URL endpoint serves
 * the HTML directly; the user can print/save-as-PDF from the browser.
 *
 * The `help_doc_versions` row is UPSERTed with the storage_path so
 * subsequent polls return `state='ready'`.
 *
 * **Operator opt-in:** install `puppeteer` + replace the marked block
 * below with a real Puppeteer PDF render. Storage upload + cache UPSERT
 * stay identical. Documented in MEMORY D-067.
 */

import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import { renderAllDocsConcatenated } from "@/lib/help-ai/markdown-render";
import { env } from "@/lib/env";

interface ExportPayload {
  tenant_id: string;
  job_id: string;
  code_version: string;
}

export const helpDocsPdfGenerate = inngest.createFunction(
  {
    id: "help-docs-pdf-generate",
    triggers: [{ event: "help/docs.export.pdf" }],
  },
  async ({ event }) => {
    const ctx = tenantContextFromInngestEvent(event);
    const data = event.data as ExportPayload;
    const db = tenantClient(ctx);

    const html = await renderAllDocsConcatenated();

    // Wrap with print-friendly stylesheet so the result is usable as
    // either HTML or a future Puppeteer PDF input.
    const wrapped = wrapWithPrintCss(html);

    // TODO(puppeteer-pdf): replace the next 3 lines with a Puppeteer
    // headless render to PDF. Until then we upload the HTML as
    // `{job_id}.html` — the browser print path works without the
    // Puppeteer install. Operator approves the dep then wires the call.
    const buffer = Buffer.from(wrapped, "utf8");
    const extension = "html";
    const contentType = "text/html";

    const storage_path = `tenant_${ctx.tenant_id}/help-docs/${data.code_version}-pdf.${extension}`;
    const { error: uploadErr } = await db.storage
      .from("help-docs")
      .upload(storage_path, buffer, { contentType, upsert: true });
    if (uploadErr) {
      throw new Error(`[help-docs-pdf-generate] storage upload failed: ${uploadErr.message}`);
    }

    const ttl = env().HELP_DOCS_CACHE_TTL_SECONDS;
    const expires_at = new Date(Date.now() + ttl * 1000).toISOString();
    await db
      .from("help_doc_versions")
      .update({ storage_path, expires_at, size_bytes: buffer.length })
      .eq("id", data.job_id);

    return { job_id: data.job_id, storage_path, size_bytes: buffer.length };
  },
);

function wrapWithPrintCss(html: string): string {
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8">',
    "<title>AI Travel Concierge — Help</title>",
    "<style>",
    "  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111; line-height: 1.5; }",
    "  h1 { font-size: 22pt; margin-top: 2rem; page-break-before: always; }",
    "  h1:first-of-type { page-break-before: avoid; }",
    "  h2 { font-size: 16pt; margin-top: 1.5rem; }",
    "  hr.help-doc-separator { margin: 2rem 0; border: none; border-top: 1px solid #ccc; }",
    "  pre, code { font-family: ui-monospace, monospace; background: #f3f4f6; padding: 0.1rem 0.3rem; }",
    "</style>",
    "</head><body>",
    html,
    "</body></html>",
  ].join("\n");
}
