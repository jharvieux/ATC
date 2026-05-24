/**
 * BP31 §32.3.4 — Sync help docs into the RAG service.
 *
 * Reads every file under `apps/main/content/help/`, chunks ~500 tokens,
 * and ingests via the RAG service's admin endpoint with
 * `retrieval_audience='help_ai'` (per the revised §32.3.4 — NOT a new scope).
 * The Help AI retrieves these chunks; customer-facing personas never see them.
 *
 * Invoked by the release pipeline (out of scope per the CI/CD spec).
 * Operator can run locally for testing:
 *
 *   RAG_SERVICE_URL=... \
 *   SERVICE_JWT_PRIVATE_KEY=... SERVICE_JWT_KEY_ID=... \
 *   OPENAI_API_KEY=... \
 *   tsx apps/main/scripts/sync-help-docs-to-rag.ts
 *
 * Idempotent: each chunk carries a content_hash; re-running UPSERTs
 * unchanged chunks (no-op) and replaces changed ones.
 *
 * **NOTE:** the embeddings call below is a TODO. The instrumented wrapper
 * exposes `instrumentedOpenAIEmbedding`-style helpers per BP27, but this
 * sync runs out-of-band (not in a request context) and would attribute
 * to PLATFORM_TENANT_ID. To avoid burning OpenAI budget on every CI run
 * we leave the call site marked TODO; the operator wires it when they
 * run the first production sync. The chunking + serialization logic
 * runs deterministically and produces the payload shape the RAG endpoint
 * expects.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const DOCS_DIR = resolve(__dirname, "..", "content", "help");
const CHUNK_TOKEN_TARGET = 500;
const CHARS_PER_TOKEN = 4; // conservative average; matches the chunker in the RAG ingest pipeline

interface Chunk {
  source_file: string;
  doc_slug: string;
  doc_title: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  retrieval_audience: "help_ai";
}

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  return { meta, body: m[2]! };
}

function splitIntoChunks(body: string, targetChars: number): string[] {
  // Paragraph-aware split: prefer paragraph boundaries; fall back to
  // sentence boundary if a paragraph exceeds target.
  const paragraphs = body.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paragraphs) {
    if (buf.length + p.length + 2 > targetChars && buf.length > 0) {
      chunks.push(buf.trim());
      buf = "";
    }
    if (p.length > targetChars) {
      // Sentence-split for oversized paragraphs.
      for (const sentence of p.match(/[^.!?]+[.!?]+\s*/g) ?? [p]) {
        if (buf.length + sentence.length > targetChars && buf.length > 0) {
          chunks.push(buf.trim());
          buf = "";
        }
        buf += sentence;
      }
    } else {
      buf += (buf.length > 0 ? "\n\n" : "") + p;
    }
  }
  if (buf.trim().length > 0) chunks.push(buf.trim());
  return chunks;
}

function buildChunks(): Chunk[] {
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md")).sort();
  const result: Chunk[] = [];
  for (const file of files) {
    const raw = readFileSync(join(DOCS_DIR, file), "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const slug = meta.slug ?? file.replace(/\.md$/, "");
    const title = meta.title ?? slug;
    const pieces = splitIntoChunks(body, CHUNK_TOKEN_TARGET * CHARS_PER_TOKEN);
    pieces.forEach((content, i) => {
      const hash = createHash("sha256").update(`${slug}|${i}|${content}`).digest("hex").slice(0, 16);
      result.push({
        source_file: file,
        doc_slug: slug,
        doc_title: title,
        chunk_index: i,
        content,
        content_hash: hash,
        retrieval_audience: "help_ai",
      });
    });
  }
  return result;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const chunks = buildChunks();

  console.log(`[sync-help-docs-to-rag] built ${chunks.length} chunks from ${DOCS_DIR}`);
  for (const c of chunks) {
    console.log(`  - ${c.doc_slug} #${c.chunk_index} (${c.content.length} chars, hash=${c.content_hash})`);
  }

  if (dryRun) {
    console.log("[sync-help-docs-to-rag] --dry-run: skipping embedding + RAG ingest");
    return;
  }

  // TODO(operator): wire the actual embedding + POST to
  // ${RAG_SERVICE_URL}/api/admin/ingest/platform-docs with X-Platform-Docs-Source
  // header + signed service JWT. The chunking output above is the deterministic
  // input to that POST. Leave the call site empty until the operator approves
  // the per-release OpenAI embedding cost (~$0.0001/chunk × N chunks).
  console.log("[sync-help-docs-to-rag] embedding + ingest not wired — operator opt-in (D-067)");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[sync-help-docs-to-rag] crashed:", err);
    process.exit(1);
  });
}

// Test helper exports (the build-and-hash logic is pure and worth pinning).
export { buildChunks, splitIntoChunks, parseFrontMatter };
