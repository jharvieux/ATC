/**
 * BP31 §32.3.3 — Help docs PDF export Inngest function.
 *
 * Renders the concatenated help docs to a real PDF via @react-pdf/renderer
 * (already a dep from BP39's itinerary PDF work). Uploads the bytes to
 * the `help-docs` Supabase Storage bucket and UPSERTs the
 * `help_doc_versions` row so subsequent polls return `state='ready'`.
 *
 * Prior implementation uploaded HTML and asked the user to print-to-PDF
 * from the browser because Puppeteer's ~200MB Chromium install was
 * deferred. react-pdf doesn't ship a browser, so we get binary PDFs
 * without the dep weight.
 */

import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import { renderHelpDocsPdf } from "@/lib/help-docs/help-docs-pdf";
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

    const buffer = await renderHelpDocsPdf();

    const storage_path = `tenant_${ctx.tenant_id}/help-docs/${data.code_version}-pdf.pdf`;
    const { error: uploadErr } = await db.storage
      .from("help-docs")
      .upload(storage_path, buffer, { contentType: "application/pdf", upsert: true });
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
