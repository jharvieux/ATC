/**
 * BP31 §32.3.3 — Help docs Word export Inngest function.
 *
 * Uses `docx-js` (Packer) to produce a real .docx binary from the
 * concatenated docs. Each section becomes a Heading 1 + body paragraphs.
 *
 * The conversion is intentionally simple — Markdown nuances (tables,
 * fenced code blocks with syntax highlighting, embedded images) aren't
 * preserved in Word output. The intended use is offline reading + redlining;
 * the canonical viewer is the in-app HTML render.
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import { loadAllDocs } from "@/lib/help-ai/docs-loader";
import { env } from "@/lib/env";

interface ExportPayload {
  tenant_id: string;
  job_id: string;
  code_version: string;
}

/**
 * Convert a markdown doc to a flat list of docx paragraphs.
 *
 * This is a minimal converter — it recognizes:
 *   - lines starting with `#`  → Heading levels (counts the #)
 *   - lines starting with `-` or `*` → bullet paragraph
 *   - blank lines → paragraph breaks
 *   - everything else → plain Paragraph
 *
 * Tables, code fences, blockquotes flatten to plain text. Good enough
 * for the v1 help corpus.
 */
function markdownToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const rawLine of md.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      out.push(new Paragraph({}));
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2] ?? "";
      const headingLevel =
        level === 1
          ? HeadingLevel.HEADING_1
          : level === 2
            ? HeadingLevel.HEADING_2
            : level === 3
              ? HeadingLevel.HEADING_3
              : HeadingLevel.HEADING_4;
      out.push(new Paragraph({ heading: headingLevel, children: [new TextRun(text)] }));
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      out.push(new Paragraph({ children: [new TextRun(`• ${line.slice(2)}`)] }));
      continue;
    }
    out.push(new Paragraph({ children: [new TextRun(line)] }));
  }
  return out;
}

export const helpDocsDocxGenerate = inngest.createFunction(
  {
    id: "help-docs-docx-generate",
    triggers: [{ event: "help/docs.export.docx" }],
  },
  async ({ event }) => {
    const ctx = tenantContextFromInngestEvent(event);
    const data = event.data as ExportPayload;
    const db = tenantClient(ctx);

    const docs = loadAllDocs();
    const sections: Paragraph[] = [];
    for (const d of docs) {
      sections.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun(d.title)],
        }),
      );
      sections.push(...markdownToParagraphs(d.body_markdown));
      sections.push(new Paragraph({})); // section break
    }

    const docxDoc = new Document({
      sections: [{ properties: {}, children: sections }],
    });
    const buffer = await Packer.toBuffer(docxDoc);

    const storage_path = `tenant_${ctx.tenant_id}/help-docs/${data.code_version}-docx.docx`;
    const { error: uploadErr } = await db.storage
      .from("help-docs")
      .upload(storage_path, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        upsert: true,
      });
    if (uploadErr) {
      throw new Error(`[help-docs-docx-generate] storage upload failed: ${uploadErr.message}`);
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
