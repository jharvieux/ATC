// BP31 §32.3.1 / §32.6.1 — help docs loader.
//
// Pins: front-matter parsing, listing sort order, slug lookup, fuzzy
// search ranking + snippet shape.

import { describe, it, expect } from "vitest";
import {
  loadAllDocs,
  getDocBySlug,
  listDocs,
  listDocsForTier,
  searchDocs,
  _resetDocsCacheForTests,
} from "@/lib/help-ai/docs-loader";

describe("docs-loader", () => {
  it("loads the committed help docs and sorts by `order`", () => {
    _resetDocsCacheForTests();
    const docs = loadAllDocs();
    expect(docs.length).toBeGreaterThanOrEqual(2);
    // 'getting-started' (order 1) should come before 'troubleshooting' (order 12).
    const slugs = docs.map((d) => d.slug);
    const gsIdx = slugs.indexOf("getting-started");
    const tsIdx = slugs.indexOf("troubleshooting");
    expect(gsIdx).toBeGreaterThanOrEqual(0);
    expect(tsIdx).toBeGreaterThan(gsIdx);
  });

  it("parses front-matter title/slug/order/category", () => {
    const doc = getDocBySlug("getting-started");
    expect(doc).toBeDefined();
    expect(doc?.title).toBe("Getting started");
    expect(doc?.order).toBe(1);
    expect(doc?.category).toBe("setup");
    expect(doc?.body_markdown.startsWith("# Getting started")).toBe(true);
  });

  it("listDocs returns metadata only (no markdown body)", () => {
    const items = listDocs();
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(["category", "order", "slug", "title"]);
    }
  });

  it("getDocBySlug returns undefined for unknown slug", () => {
    expect(getDocBySlug("does-not-exist")).toBeUndefined();
  });
});

describe("listDocsForTier", () => {
  it("returns BYO-tier-tagged docs when filtering on a BYO tier", () => {
    _resetDocsCacheForTests();
    const byoDocs = listDocsForTier("byo_research");
    const slugs = byoDocs.map((d) => d.slug);
    expect(slugs).toContain("quickstart-byo");
    expect(slugs).not.toContain("quickstart-subhost");
  });

  it("returns sub-host-tier-tagged docs when filtering on a subscription tier", () => {
    _resetDocsCacheForTests();
    const subDocs = listDocsForTier("sub_pro");
    const slugs = subDocs.map((d) => d.slug);
    expect(slugs).toContain("quickstart-subhost");
    expect(slugs).not.toContain("quickstart-byo");
  });

  it("includes docs with empty tiers (treated as universal)", () => {
    _resetDocsCacheForTests();
    // 'getting-started' has no tiers: field → should appear for every tier.
    const byoDocs = listDocsForTier("byo_research");
    const subDocs = listDocsForTier("sub_pro");
    expect(byoDocs.map((d) => d.slug)).toContain("getting-started");
    expect(subDocs.map((d) => d.slug)).toContain("getting-started");
  });
});

describe("searchDocs", () => {
  it("returns empty for queries under 2 chars (via the route guard pattern; here we check the lib accepts empty)", () => {
    expect(searchDocs("")).toEqual([]);
  });

  it("matches body content and includes a snippet", () => {
    const hits = searchDocs("CNAME");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.snippet).toContain("cname");
    expect(hits[0]?.slug).toBe("troubleshooting");
  });

  it("ranks title matches higher than body-only matches", () => {
    // 'getting started' appears in the getting-started title; should rank
    // ahead of any doc that just mentions 'getting' in body text.
    const hits = searchDocs("getting started");
    expect(hits[0]?.slug).toBe("getting-started");
  });
});
