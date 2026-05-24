/**
 * BP31 §32.3.1 — Help docs loader.
 *
 * Reads .md files from `apps/main/content/help/` at build/runtime, parses
 * YAML front-matter, returns a structured listing sorted by `order`.
 *
 * Source of truth: the file system. There's no DB-side doc registry —
 * docs ship with code and version with the platform per §32.3.1.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface HelpDoc {
  /** From front-matter; e.g., 'getting-started' */
  slug: string;
  /** Display title from front-matter */
  title: string;
  /** Sort order; smaller is earlier */
  order: number;
  /** Free-form category tag */
  category: string;
  /** Markdown body (front-matter stripped) */
  body_markdown: string;
  /** Source file basename — used for cache keys */
  file_name: string;
}

const DOCS_DIR = resolve(__dirname, "..", "..", "..", "content", "help");

/** Bare-bones YAML front-matter parser — only handles the 4 string/number
 *  keys we declare. Avoids pulling in a full YAML dependency. */
function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    return { meta: {}, body: raw };
  }
  const headerRaw = m[1]!;
  const body = m[2]!;
  const meta: Record<string, string> = {};
  for (const line of headerRaw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  return { meta, body };
}

let _cached: HelpDoc[] | null = null;

/** Load all help docs once per process. Cache is fine — content ships with
 *  the deploy; restart triggers re-read.
 *  Test helper: pass `forceFresh=true` to bypass the cache. */
export function loadAllDocs(forceFresh = false): HelpDoc[] {
  if (_cached && !forceFresh) return _cached;
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")).sort();
  const docs: HelpDoc[] = [];
  for (const file of files) {
    const raw = readFileSync(join(DOCS_DIR, file), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    if (!meta.slug || !meta.title) continue; // skip malformed
    const order = parseInt(meta.order ?? "999", 10);
    docs.push({
      slug: meta.slug,
      title: meta.title,
      order: Number.isFinite(order) ? order : 999,
      category: meta.category ?? "general",
      body_markdown: body.trimStart(),
      file_name: file,
    });
  }
  docs.sort((a, b) => a.order - b.order);
  _cached = docs;
  return docs;
}

export function getDocBySlug(slug: string): HelpDoc | undefined {
  return loadAllDocs().find((d) => d.slug === slug);
}

export function listDocs(): Array<Pick<HelpDoc, "slug" | "title" | "order" | "category">> {
  return loadAllDocs().map((d) => ({ slug: d.slug, title: d.title, order: d.order, category: d.category }));
}

/** Naive in-memory fuzzy search. Returns matches with a short snippet
 *  around the first hit. Spec offers full-text DB index OR client fuzzy
 *  as alternatives; this is the client-fuzzy implementation kept on the
 *  server so the UI doesn't have to fetch every doc body.
 *  Operator choice documented in MEMORY D-067. */
export function searchDocs(query: string): Array<{ slug: string; title: string; snippet: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: Array<{ slug: string; title: string; snippet: string; score: number }> = [];
  for (const doc of loadAllDocs()) {
    const haystack = `${doc.title}\n${doc.body_markdown}`.toLowerCase();
    const idx = haystack.indexOf(q);
    if (idx < 0) continue;
    const ctxStart = Math.max(0, idx - 60);
    const ctxEnd = Math.min(haystack.length, idx + q.length + 60);
    const snippet = haystack.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim();
    // Title hits rank higher.
    const score = doc.title.toLowerCase().includes(q) ? 0 : idx;
    results.push({ slug: doc.slug, title: doc.title, snippet: `…${snippet}…`, score });
  }
  results.sort((a, b) => a.score - b.score);
  return results.map(({ score: _score, ...rest }) => rest);
}

/** Reset the cache — test-only. */
export function _resetDocsCacheForTests(): void {
  _cached = null;
}
