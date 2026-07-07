/**
 * BP31 §32.3.3 — Markdown → HTML rendering for help docs.
 *
 * Uses the standard remark/rehype unified pipeline. Same renderer drives:
 *   - per-doc viewer at /admin/help/[slug]
 *   - concat-all view at /admin/help/print
 *   - the PDF/Word export inputs
 *
 * The renderer is intentionally NOT customer-input-bearing — every input
 * comes from `apps/main/content/help/*.md` which ships with the repo and
 * passes through code review. We therefore allow raw HTML in the source
 * (`allowDangerousHtml: true`) for things like `<!-- TODO -->` comments
 * that disappear in HTML. **Do NOT use this renderer for user-supplied
 * markdown** — the rehype-sanitize step is absent because the trust
 * boundary is at code-review time, not runtime.
 */

// `remark` is the all-in-one bundle (remark-parse + remark-stringify);
// we use the `unified` low-level chain so we can swap to rehype after
// parsing markdown.
import { remark } from "remark";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";

import { escapeHtml } from "@/lib/utils";
import { loadAllDocs, type HelpDoc } from "./docs-loader";

const renderer = remark()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true });

export async function renderMarkdown(md: string): Promise<string> {
  const file = await renderer.process(md);
  return String(file);
}

/**
 * Concatenate every doc into one HTML string, separated by `<hr>` and
 * `<h1>` section headers from each doc's title. Used by the print view
 * and by the PDF/Word export pipeline so output ordering matches the
 * `order` front-matter field.
 */
export async function renderAllDocsConcatenated(): Promise<string> {
  const docs = loadAllDocs();
  const sections: string[] = [];
  for (const doc of docs) {
    const html = await renderMarkdown(doc.body_markdown);
    sections.push(
      `<section data-help-section="${doc.slug}">` +
        `<h1 id="${doc.slug}">${escapeHtml(doc.title)}</h1>\n` +
        html +
        `</section>`,
    );
  }
  return sections.join('\n<hr class="help-doc-separator" />\n');
}

/** Render a single doc to HTML. Helper for /api/help/docs/[slug]. */
export async function renderDocHtml(doc: HelpDoc): Promise<string> {
  return renderMarkdown(doc.body_markdown);
}
