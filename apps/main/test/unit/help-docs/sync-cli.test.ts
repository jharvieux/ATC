// BP31 §32.3.4 — sync-help-docs-to-rag.ts pure helpers.
//
// The script's runtime path is operator-gated (no embedding call wired
// until the operator opts in). The deterministic chunking + hash logic
// is what callers depend on for idempotency, so we pin it.

import { describe, it, expect } from "vitest";
import {
  buildChunks,
  splitIntoChunks,
  parseFrontMatter,
} from "../../../scripts/sync-help-docs-to-rag";

describe("parseFrontMatter", () => {
  it("extracts title/slug/order/category from a well-formed file", () => {
    const raw = "---\ntitle: My doc\nslug: my-doc\norder: 5\ncategory: ops\n---\n# Body\n";
    const { meta, body } = parseFrontMatter(raw);
    expect(meta.title).toBe("My doc");
    expect(meta.slug).toBe("my-doc");
    expect(meta.order).toBe("5");
    expect(meta.category).toBe("ops");
    expect(body.trim()).toBe("# Body");
  });

  it("returns empty meta + raw body when front-matter is absent", () => {
    const raw = "no frontmatter here\n# Body";
    const { meta, body } = parseFrontMatter(raw);
    expect(meta).toEqual({});
    expect(body).toBe(raw);
  });
});

describe("splitIntoChunks", () => {
  it("keeps a short body in one chunk", () => {
    const chunks = splitIntoChunks("just a tiny paragraph", 100);
    expect(chunks).toEqual(["just a tiny paragraph"]);
  });

  it("splits at paragraph boundaries when total exceeds target", () => {
    const body = "P1\n\nP2\n\nP3";
    const chunks = splitIntoChunks(body, 5);
    expect(chunks.length).toBe(3);
    expect(chunks).toEqual(["P1", "P2", "P3"]);
  });
});

describe("buildChunks", () => {
  it("produces chunks for every committed doc with stable content_hash", () => {
    const a = buildChunks();
    const b = buildChunks();
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.content_hash).toBe(b[i]?.content_hash);
      expect(a[i]?.retrieval_audience).toBe("help_ai");
    }
  });

  it("tags every chunk with retrieval_audience='help_ai'", () => {
    const chunks = buildChunks();
    for (const c of chunks) {
      expect(c.retrieval_audience).toBe("help_ai");
    }
  });
});
