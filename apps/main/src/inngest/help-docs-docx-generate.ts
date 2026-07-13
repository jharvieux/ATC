/**
 * BP31 §32.3.3 — Help docs Word export Inngest function.
 *
 * Uses `docx-js` (Packer) to produce a real .docx binary from the
 * concatenated docs. Each section becomes a Heading 1 + body paragraphs.
 *
 * The conversion is intentionally simple — Markdown nuances (tables,
 * fenced code blocks with syntax highlighting) flatten to plain text.
 * `![alt](/help/...)` images ARE embedded (#1688) by reading the file
 * off `public/help` on disk, since the worker has no browser origin to
 * resolve a relative src against. The intended use is offline reading +
 * redlining; the canonical viewer is the in-app HTML render.
 */

import { z } from "zod";
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import { loadAllDocs } from "@/lib/help-ai/docs-loader";
import { env } from "@/lib/env";
import { safeAwait } from "@/lib/db/safe-mutation";
import { pngDimensions, resolveHelpImage } from "@/lib/help-docs/resolve-image";

const DOCX_MAX_IMAGE_WIDTH = 500;

/** Scale a resolved PNG down to fit DOCX_MAX_IMAGE_WIDTH, preserving
 *  aspect ratio. Non-PNG formats (docx still supports jpg/gif/bmp) don't
 *  carry a header we parse, so they get a fixed placeholder box — good
 *  enough for the v1 help corpus, which ships PNG screenshots. */
function imageTransformation(data: Buffer): { width: number; height: number } {
  const dims = pngDimensions(data);
  if (!dims) return { width: DOCX_MAX_IMAGE_WIDTH, height: 300 };
  if (dims.width <= DOCX_MAX_IMAGE_WIDTH) return dims;
  const scale = DOCX_MAX_IMAGE_WIDTH / dims.width;
  return { width: DOCX_MAX_IMAGE_WIDTH, height: Math.round(dims.height * scale) };
}

const ExportPayloadSchema = z.object({
  tenant_id: z.string(),
  job_id: z.string(),
  code_version: z.string(),
});
type ExportPayload = z.infer<typeof ExportPayloadSchema>;

/**
 * Convert a markdown doc to a flat list of docx paragraphs.
 *
 * This is a minimal converter — it recognizes:
 *   - lines starting with `#`  → Heading levels (counts the #)
 *   - lines starting with `-` or `*` → bullet paragraph
 *   - `![alt](/help/...)` → embedded ImageRun, read from disk
 *   - blank lines → paragraph breaks
 *   - everything else → plain Paragraph
 *
 * Tables, code fences, blockquotes flatten to plain text. Good enough
 * for the v1 help corpus.
 */
export function markdownToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const rawLine of md.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      out.push(new Paragraph({}));
      continue;
    }
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      const alt = imgMatch[1] ?? "";
      const src = imgMatch[2]!;
      const resolved = resolveHelpImage(src);
      if (!resolved) {
        console.warn(`[help-docs-docx-generate] image not found, skipping: ${src}`);
        continue;
      }
      out.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: resolved.type,
              data: resolved.data,
              transformation: imageTransformation(resolved.data),
              altText: { name: alt || "help doc image", description: alt },
            }),
          ],
        }),
      );
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
  async ({ event, step }) => {
    const parsed = ExportPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[help-docs-docx-generate] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const data: ExportPayload = parsed.data;
    const ctx = tenantContextFromInngestEvent(event);
    const db = tenantClient(ctx);

    // #1816 — render/upload/DB-update each get their own step.run boundary so
    // a retry resumes instead of re-executing the whole pipeline (rendering
    // re-reads and re-parses every embedded image, #1811). A Buffer doesn't
    // survive Inngest's JSON step-state round-trip as a real Buffer instance,
    // so the step returns base64 and this reconstructs it on the way out.
    const renderedBase64 = await step.run("render-docx", async () => {
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
      return buffer.toString("base64");
    });
    const buffer = Buffer.from(renderedBase64, "base64");

    const storage_path = `tenant_${ctx.tenant_id}/help-docs/${data.code_version}-docx.docx`;
    await step.run("upload-docx", async () => {
      const { error: uploadErr } = await db.storage
        .from("help-docs")
        .upload(storage_path, buffer, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          upsert: true,
        });
      if (uploadErr) {
        throw new Error(`[help-docs-docx-generate] storage upload failed: ${uploadErr.message}`);
      }
    });

    const ttl = env().HELP_DOCS_CACHE_TTL_SECONDS;
    const expires_at = new Date(Date.now() + ttl * 1000).toISOString();
    await step.run("update-version-row", () =>
      safeAwait(db
        .from("help_doc_versions")
        .update({ storage_path, expires_at, size_bytes: buffer.length })
        .eq("id", data.job_id), "help_doc_versions.update"),
    );

    return { job_id: data.job_id, storage_path, size_bytes: buffer.length };
  },
);
