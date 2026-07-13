// BP41 §33.5 / §33.11 — sample selector for the OCR evaluation.
//
// Picks 200 deck-plan images stratified across cruise lines so the
// sample isn't dominated by whichever line happens to have the most
// chunks. Stratification proportional to per-line distribution, capped
// per line so no single line consumes more than ~30% of the sample.

import postgres from "postgres";
import { redactSecrets } from "../../lib/redact-secrets";

const TOTAL_SAMPLE = 200;
const PER_LINE_CAP_RATIO = 0.30;

interface AssetRow {
  asset_id: string;
  entity_id: string;
  image_url: string;
  source_page_url: string;
  cruise_line_or_supplier: string | null;
  ship_or_property: string | null;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_RAG_DB_URL;
  if (!url) {
    console.error("SUPABASE_RAG_DB_URL must be set (RAG service Postgres connection).");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, idle_timeout: 10 });

  // Join asset → its referencing chunk to capture the cruise line context.
  // The deck-plan asset's entity_id encodes ship-slug + deck (BP37); the
  // chunk that references it carries cruise_line_or_supplier.
  const rows = await sql<AssetRow[]>`
    SELECT a.asset_id, a.entity_id, a.image_url, a.source_page_url,
           c.cruise_line_or_supplier, c.ship_or_property
    FROM public.rag_media_assets a
    LEFT JOIN public.knowledge_chunks c
      ON a.asset_id = ANY(c.related_asset_ids)
    WHERE a.kind = 'deck_plan' AND a.scope = 'global'
  `;

  if (rows.length === 0) {
    console.error("No deck_plan assets found in rag_media_assets.");
    await sql.end();
    process.exit(2);
  }

  // Group by cruise line.
  const byLine = new Map<string, AssetRow[]>();
  for (const r of rows) {
    const line = r.cruise_line_or_supplier ?? "UNKNOWN";
    const arr = byLine.get(line) ?? [];
    arr.push(r);
    byLine.set(line, arr);
  }

  const perLineCap = Math.floor(TOTAL_SAMPLE * PER_LINE_CAP_RATIO);
  const lines = [...byLine.keys()];
  const sample: AssetRow[] = [];

  // Proportional pass with cap.
  const total = rows.length;
  for (const line of lines) {
    const pool = byLine.get(line) ?? [];
    const proportional = Math.round((pool.length / total) * TOTAL_SAMPLE);
    const take = Math.min(proportional, perLineCap, pool.length);
    sample.push(...shuffle(pool).slice(0, take));
  }

  // Top up to TOTAL_SAMPLE with random remaining (without re-using the
  // already-picked) — picks the best per-line spillover.
  const picked = new Set(sample.map((s) => s.asset_id));
  if (sample.length < TOTAL_SAMPLE) {
    const remainder = shuffle(rows.filter((r) => !picked.has(r.asset_id)));
    for (const r of remainder) {
      if (sample.length >= TOTAL_SAMPLE) break;
      sample.push(r);
    }
  }
  // Trim to exactly TOTAL_SAMPLE.
  sample.length = Math.min(sample.length, TOTAL_SAMPLE);

  process.stdout.write(JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      total_pool: rows.length,
      sample_size: sample.length,
      per_line_distribution: Object.fromEntries(
        [...byLine.entries()].map(([line, arr]) => [
          line,
          { pool: arr.length, picked: sample.filter((s) => (s.cruise_line_or_supplier ?? "UNKNOWN") === line).length },
        ]),
      ),
      sample,
    },
    null,
    2,
  ) + "\n");

  await sql.end();
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

main().catch((err) => {
  console.error(redactSecrets(err));
  process.exit(1);
});
