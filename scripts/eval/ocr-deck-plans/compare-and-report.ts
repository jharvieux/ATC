// BP41 §33.5 / §33.11 — comparison + markdown report.
//
// Reads results.jsonl, pulls the corresponding knowledge_chunks rows
// from the RAG service, scores each image as:
//   - new info       (OCR added something not in the text chunk)
//   - corroboration  (OCR confirmed what the text said)
//   - contradiction  (OCR contradicted the text — possible parse error)
// Aggregates per cruise line + overall, writes reports/ocr-eval-{date}.md.
//
// Scoring heuristic is keyword-overlap (intentionally crude — the report
// surfaces RAW samples for human review; the aggregate is directional).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import postgres from "postgres";

const RESULTS_PATH = "scripts/eval/ocr-deck-plans/results.jsonl";

interface ResultLine {
  asset_id: string;
  ok: boolean;
  output_text?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  error?: string;
  cruise_line: string | null;
  ship: string | null;
  image_url: string;
  source_page_url: string;
  ts: string;
}

interface ChunkRow {
  id: string;
  content: string;
  related_asset_ids: string[] | null;
}

interface PerImageScore {
  asset_id: string;
  cruise_line: string;
  ship: string;
  ocr_tokens: number;
  chunk_tokens_overlap: number;
  ocr_unique_tokens: number;
  new_info: boolean;
  contradiction: boolean;
  cost_usd: number;
  sample_ocr_excerpt: string;
  sample_chunk_excerpt: string;
}

const CONTRADICTION_KEYWORDS = [
  // "Deck 9" vs "Deck 8" type contradictions are common; we look for
  // simple deck-number mismatches as a starter heuristic.
];

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function deckNumberFromText(s: string): number | null {
  const m = /\bdeck\s*(\d+)/i.exec(s);
  return m ? parseInt(m[1] ?? "0", 10) || null : null;
}

async function main(): Promise<void> {
  if (!existsSync(RESULTS_PATH)) {
    console.error(`${RESULTS_PATH} not found. Run run-haiku-vision.ts first.`);
    process.exit(1);
  }
  const url = process.env.SUPABASE_RAG_DB_URL;
  if (!url) {
    console.error("SUPABASE_RAG_DB_URL must be set.");
    process.exit(1);
  }
  mkdirSync("reports", { recursive: true });

  const results: ResultLine[] = [];
  for (const line of readFileSync(RESULTS_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { results.push(JSON.parse(line) as ResultLine); } catch { /* skip */ }
  }

  const sql = postgres(url, { max: 1, idle_timeout: 10 });

  // Batch-fetch every chunk that references our sample asset IDs.
  const assetIds = results.map((r) => r.asset_id);
  const chunkRows = await sql<ChunkRow[]>`
    SELECT id, content, related_asset_ids
    FROM public.knowledge_chunks
    WHERE related_asset_ids && ${assetIds}::uuid[]
  `;
  const chunkByAsset = new Map<string, ChunkRow>();
  for (const row of chunkRows) {
    for (const aid of row.related_asset_ids ?? []) {
      if (!chunkByAsset.has(aid)) chunkByAsset.set(aid, row);
    }
  }

  const scores: PerImageScore[] = [];
  for (const r of results) {
    if (!r.ok || !r.output_text) continue;
    const chunk = chunkByAsset.get(r.asset_id);
    const chunkText = chunk?.content ?? "";
    const ocrTokens = tokenize(r.output_text);
    const chunkTokens = tokenize(chunkText);
    const overlap = [...ocrTokens].filter((t) => chunkTokens.has(t)).length;
    const unique = ocrTokens.size - overlap;

    const ocrDeck = deckNumberFromText(r.output_text);
    const chunkDeck = deckNumberFromText(chunkText);
    const contradiction = ocrDeck != null && chunkDeck != null && ocrDeck !== chunkDeck;

    // "new_info" heuristic: OCR contributes ≥30% of its tokens beyond the chunk.
    const newInfo = ocrTokens.size > 0 && unique / ocrTokens.size >= 0.30;

    scores.push({
      asset_id: r.asset_id,
      cruise_line: r.cruise_line ?? "UNKNOWN",
      ship: r.ship ?? "UNKNOWN",
      ocr_tokens: ocrTokens.size,
      chunk_tokens_overlap: overlap,
      ocr_unique_tokens: unique,
      new_info: newInfo,
      contradiction,
      cost_usd: r.cost_usd ?? 0,
      sample_ocr_excerpt: r.output_text.slice(0, 240).replace(/\s+/g, " ").trim(),
      sample_chunk_excerpt: chunkText.slice(0, 240).replace(/\s+/g, " ").trim(),
    });
  }

  // Aggregates.
  const total = scores.length;
  const newInfoPct = total > 0 ? (scores.filter((s) => s.new_info).length / total) * 100 : 0;
  const contradictionPct = total > 0 ? (scores.filter((s) => s.contradiction).length / total) * 100 : 0;
  const totalCost = scores.reduce((s, x) => s + x.cost_usd, 0);
  const avgCost = total > 0 ? totalCost / total : 0;

  // Per-line summary.
  const perLine = new Map<string, { count: number; new_info: number; contradiction: number; cost: number }>();
  for (const s of scores) {
    const e = perLine.get(s.cruise_line) ?? { count: 0, new_info: 0, contradiction: 0, cost: 0 };
    e.count += 1;
    if (s.new_info) e.new_info += 1;
    if (s.contradiction) e.contradiction += 1;
    e.cost += s.cost_usd;
    perLine.set(s.cruise_line, e);
  }

  // Rubric thresholds (mirrors reports/ocr-eval-rubric.md).
  const RUBRIC_UPLIFT = 40;
  const RUBRIC_CONTRADICTION = 5;
  const RUBRIC_COST = 0.05;

  const goNoGo = (
    newInfoPct >= RUBRIC_UPLIFT &&
    contradictionPct < RUBRIC_CONTRADICTION &&
    avgCost < RUBRIC_COST
  ) ? "GO" : "NO-GO";

  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# OCR Eval Report — ${date}`);
  lines.push("");
  lines.push("Generated by `scripts/eval/ocr-deck-plans/compare-and-report.ts`. Rubric in `reports/ocr-eval-rubric.md`.");
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push(`- Images scored: **${total}**`);
  lines.push(`- New-info rate: **${newInfoPct.toFixed(1)}%** (rubric ≥${RUBRIC_UPLIFT}%)`);
  lines.push(`- Contradiction rate: **${contradictionPct.toFixed(1)}%** (rubric <${RUBRIC_CONTRADICTION}%)`);
  lines.push(`- Total spend: **$${totalCost.toFixed(4)}**`);
  lines.push(`- Avg cost per image: **$${avgCost.toFixed(4)}** (rubric <$${RUBRIC_COST.toFixed(2)})`);
  lines.push("");
  lines.push(`### Recommendation: **${goNoGo}**`);
  lines.push("");
  lines.push("## Per-cruise-line breakdown");
  lines.push("");
  lines.push("| Cruise line | Images | New-info % | Contradiction % | Total cost |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [line, e] of [...perLine.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const ni = e.count > 0 ? (e.new_info / e.count) * 100 : 0;
    const cr = e.count > 0 ? (e.contradiction / e.count) * 100 : 0;
    lines.push(`| ${line} | ${e.count} | ${ni.toFixed(1)}% | ${cr.toFixed(1)}% | $${e.cost.toFixed(4)} |`);
  }
  lines.push("");
  lines.push("## Sample comparisons (first 5 new-info hits)");
  lines.push("");
  for (const s of scores.filter((x) => x.new_info).slice(0, 5)) {
    lines.push(`### ${s.cruise_line} — ${s.ship} (asset \`${s.asset_id.slice(0, 8)}…\`)`);
    lines.push("");
    lines.push("**Existing chunk:**");
    lines.push("> " + s.sample_chunk_excerpt);
    lines.push("");
    lines.push("**OCR output:**");
    lines.push("> " + s.sample_ocr_excerpt);
    lines.push("");
  }
  if (scores.some((s) => s.contradiction)) {
    lines.push("## Contradiction samples (first 5)");
    lines.push("");
    for (const s of scores.filter((x) => x.contradiction).slice(0, 5)) {
      lines.push(`### ${s.cruise_line} — ${s.ship} (asset \`${s.asset_id.slice(0, 8)}…\`)`);
      lines.push("**Existing chunk:** " + s.sample_chunk_excerpt);
      lines.push("**OCR output:** " + s.sample_ocr_excerpt);
      lines.push("");
    }
  }
  lines.push("");
  lines.push("## Notes for follow-up");
  lines.push("");
  lines.push("- This report is directional. Spot-check 20 random images by hand before flipping go/no-go.");
  lines.push("- If GO, the follow-up prompt (NOT in this addendum's sequence) implements OCR in the production ingest path.");
  lines.push("- If NO-GO, document the call + the per-line stats above in MEMORY so a future re-eval has a baseline.");
  lines.push("");

  void CONTRADICTION_KEYWORDS;

  const outPath = `reports/ocr-eval-${date}.md`;
  writeFileSync(outPath, lines.join("\n"));
  console.log(`Report written: ${outPath}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
