// BP31 §32.3.3 — markdown→HTML renderer.

import { describe, it, expect } from "vitest";
import {
  renderMarkdown,
  renderAllDocsConcatenated,
} from "@/lib/help-ai/markdown-render";

describe("renderMarkdown", () => {
  it("renders headings to <h1> / <h2>", async () => {
    const html = await renderMarkdown("# Heading 1\n\n## Heading 2\n\nbody");
    expect(html).toContain("<h1>Heading 1</h1>");
    expect(html).toContain("<h2>Heading 2</h2>");
    expect(html).toContain("<p>body</p>");
  });

  it("renders code spans", async () => {
    const html = await renderMarkdown("Inline `code` here");
    expect(html).toContain("<code>code</code>");
  });

  it("renders ordered list items", async () => {
    const html = await renderMarkdown("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("preserves HTML comments (allowDangerousHtml — content is trusted)", async () => {
    const html = await renderMarkdown("text\n\n<!-- TODO note -->\n\nmore text");
    expect(html).toContain("<!-- TODO note -->");
  });
});

describe("renderAllDocsConcatenated", () => {
  it("renders every committed doc in order with section separators", async () => {
    const html = await renderAllDocsConcatenated();
    expect(html).toContain('data-help-section="getting-started"');
    expect(html).toContain('data-help-section="troubleshooting"');
    expect(html).toContain('class="help-doc-separator"');
    // getting-started must appear before troubleshooting (order: 1 vs 12).
    const gsIdx = html.indexOf('data-help-section="getting-started"');
    const tsIdx = html.indexOf('data-help-section="troubleshooting"');
    expect(gsIdx).toBeLessThan(tsIdx);
  });
});
