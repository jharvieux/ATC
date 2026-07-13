// #1565 — Operator-run LLM drafting of cruise_ships.signature_feature.
//
// cruise_ships.signature_feature (the group-landing ship-stats "wow" line,
// e.g. "Go-kart track on deck") has NO automated ingestion path — unlike
// guest_capacity/decks/built_year, which regex-parse cleanly from RAG's
// ship_intel chunks (see scripts/backfill-ship-stats-from-rag.sql). This
// script DRAFTS a candidate value per ship from RAG's deck_intel deck-label
// content using an LLM judgment call, for the operator to REVIEW before any
// write. It is NOT wired into CI/cron and NEVER touches a remote DB — it emits
// a JSONL of drafts + a guarded .sql the operator inspects, edits, and applies
// by hand.
//
// WORKFLOW (from repo root; do not echo the DB URL):
//
//   # 1. Export deck_intel content from RAG as JSON (robust vs. CSV quoting).
//   set -a; source .env.local; set +a
//   psql "$SUPABASE_RAG_DB_URL" -t -A -o /tmp/rag_deck_intel.json -c \
//     "SELECT json_agg(json_build_object('ship', ship_or_property, 'content', content)) \
//      FROM knowledge_chunks WHERE category = 'deck_intel' AND ship_or_property IS NOT NULL"
//
//   # 2. Draft signature features (Haiku default; $10 hard cap; resumes on rerun).
//   pnpm tsx scripts/draft-signature-features.ts
//
//   # 3. REVIEW /tmp/signature-features-draft.jsonl by hand. Each line has the
//   #    ship, the drafted feature, the model's rationale, and the source deck
//   #    text it drew from. Edit or delete any line you disagree with.
//
//   # 4. Regenerate the apply SQL from the (reviewed) JSONL, then apply to main:
//   pnpm tsx scripts/draft-signature-features.ts --sql-only
//   #    Inspect /tmp/signature-features-apply.sql, then:
//   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f /tmp/signature-features-apply.sql
//
// The emitted UPDATEs are keyed on lower(canonical_name) and guarded by
// `signature_feature IS NULL`, so applying is idempotent and never clobbers a
// value an operator already set via the admin console (#1565 part 2).

import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const INPUT_PATH = process.env.DECK_INTEL_JSON ?? "/tmp/rag_deck_intel.json";
const DRAFT_PATH = process.env.SIGNATURE_DRAFT_JSONL ?? "/tmp/signature-features-draft.jsonl";
const SQL_PATH = process.env.SIGNATURE_APPLY_SQL ?? "/tmp/signature-features-apply.sql";
const MODEL = process.env.SIGNATURE_MODEL ?? "claude-haiku-4-5-20251001";
const HARD_CAP_USD = 10;
const SIGNATURE_MAX_CHARS = 120; // must match the route's SIGNATURE_FEATURE_MAX

// claude-haiku-4-5 per-token prices (USD per 1M tokens) as of build. These are
// a spend-cap safety net, not billing truth — update on an Anthropic price change.
const PRICE_INPUT_PER_M = 0.8;
const PRICE_OUTPUT_PER_M = 4.0;

interface DeckIntelRow {
  ship: string;
  content: string;
}

export interface DraftLine {
  ship: string;
  signature_feature: string | null;
  rationale: string;
  source_excerpt: string;
  cost_usd: number;
  ts: string;
}

const PROMPT = `You are curating a single "signature feature" line for a cruise ship, shown on a group-booking landing page to make the ship feel exciting.

You will be given the ship's deck-plan labels (one line of deck names/amenities). From that text ONLY, identify the single most distinctive, marketing-worthy onboard attraction — a specific named amenity, not a generic one. Good: "Go-kart track", "FlowRider surf simulator", "Ultimate Abyss slide", "IMAX theater". Bad (too generic): "Pool", "Spa", "Buffet", "Cabins".

Rules:
- Draw ONLY from the provided text. Never invent a feature that isn't named there.
- Return null if nothing stands out beyond generic cruise amenities. A null is BETTER than a weak guess — the field is omitted when empty.
- Keep the feature under ${SIGNATURE_MAX_CHARS} characters, title-case-ish, no trailing period.

Respond with ONLY a JSON object, no prose:
{"signature_feature": "<string or null>", "rationale": "<one short sentence>"}`;

function loadRows(): DeckIntelRow[] {
  if (!existsSync(INPUT_PATH)) {
    console.error(`Input ${INPUT_PATH} not found. Run the psql export in the script header first.`);
    process.exit(1);
  }
  const raw = readFileSync(INPUT_PATH, "utf8").trim();
  if (!raw || raw === "null") {
    console.error(`Input ${INPUT_PATH} is empty — no deck_intel rows exported.`);
    process.exit(1);
  }
  const parsed = JSON.parse(raw) as DeckIntelRow[];
  // One draft per ship: first deck_intel chunk wins (matches the backfill's DISTINCT ON).
  const byShip = new Map<string, DeckIntelRow>();
  for (const r of parsed) {
    if (r.ship && r.content && !byShip.has(r.ship)) byShip.set(r.ship, r);
  }
  return [...byShip.values()];
}

function loadDrafts(): DraftLine[] {
  if (!existsSync(DRAFT_PATH)) return [];
  const out: DraftLine[] = [];
  const lines = readFileSync(DRAFT_PATH, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DraftLine);
    } catch {
      console.warn(`[signature] skipping corrupt JSONL line ${i + 1} in ${DRAFT_PATH}`);
    }
  }
  return out;
}

export function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

export function writeApplySql(drafts: DraftLine[], sqlPath: string = SQL_PATH): void {
  const applied = drafts.filter((d) => d.signature_feature !== null);
  const header = [
    "-- #1565 — signature_feature curation, DRAFTED by scripts/draft-signature-features.ts.",
    "-- REVIEW every value before applying. Keyed on lower(canonical_name) and guarded by",
    "-- signature_feature IS NULL, so this never clobbers an operator-set value and re-running",
    "-- is idempotent. Ships the model returned null for are omitted (field stays NULL).",
    "",
    "BEGIN;",
    "",
  ];
  const stmts = applied.map((d) =>
    `UPDATE public.cruise_ships SET signature_feature = '${sqlEscape(d.signature_feature!)}', updated_at = now()\n` +
    `  WHERE lower(canonical_name) = lower('${sqlEscape(d.ship)}') AND signature_feature IS NULL; -- ${d.rationale.replace(/\n/g, " ")}`,
  );
  const footer = ["", "COMMIT;", ""];
  writeFileSync(sqlPath, [...header, ...stmts, ...footer].join("\n"));
  console.log(`[signature] wrote ${applied.length} UPDATE(s) to ${sqlPath} (${drafts.length - applied.length} null/skipped).`);
}

async function draftOne(client: Anthropic, row: DeckIntelRow): Promise<DraftLine> {
  const ts = new Date().toISOString();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: `${PROMPT}\n\nShip: ${row.ship}\nDeck labels: ${row.content}` }],
  });
  const text = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const cost =
    (resp.usage.input_tokens / 1_000_000) * PRICE_INPUT_PER_M +
    (resp.usage.output_tokens / 1_000_000) * PRICE_OUTPUT_PER_M;

  let feature: string | null = null;
  let rationale = "";
  try {
    const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonStr) as { signature_feature: string | null; rationale?: string };
    rationale = parsed.rationale ?? "";
    if (typeof parsed.signature_feature === "string") {
      const trimmed = parsed.signature_feature.trim();
      // Trust the operator's review, but drop an obviously-out-of-bounds value.
      feature = trimmed === "" || trimmed.length > SIGNATURE_MAX_CHARS ? null : trimmed;
    }
  } catch {
    rationale = `UNPARSEABLE model output: ${text.slice(0, 200)}`;
  }

  return {
    ship: row.ship,
    signature_feature: feature,
    rationale,
    source_excerpt: row.content.slice(0, 300),
    cost_usd: Number(cost.toFixed(6)),
    ts,
  };
}

async function main(): Promise<void> {
  // --sql-only regenerates the apply SQL from an already-reviewed JSONL, no API calls.
  if (process.argv.includes("--sql-only")) {
    const drafts = loadDrafts();
    if (drafts.length === 0) {
      console.error(`No drafts in ${DRAFT_PATH}. Run the drafting pass first.`);
      process.exit(1);
    }
    writeApplySql(drafts);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY must be set.");
    process.exit(1);
  }

  const rows = loadRows();
  const existing = loadDrafts();
  const done = new Set(existing.map((d) => d.ship));
  let spend = existing.reduce((s, d) => s + (d.cost_usd ?? 0), 0);
  if (done.size > 0) console.log(`[signature] resume: ${done.size} already drafted, prior spend $${spend.toFixed(4)}.`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let processed = 0;

  for (const row of rows) {
    if (done.has(row.ship)) continue;
    if (spend >= HARD_CAP_USD) {
      console.error(`[signature] HARD CAP $${HARD_CAP_USD} reached (spent $${spend.toFixed(4)}). Rerun to continue.`);
      break;
    }
    const draft = await draftOne(client, row);
    appendFileSync(DRAFT_PATH, JSON.stringify(draft) + "\n");
    spend += draft.cost_usd;
    processed += 1;
    if (processed % 25 === 0) console.log(`[signature] drafted ${processed}, spend $${spend.toFixed(4)}.`);
    await new Promise((r) => setTimeout(r, 200)); // polite pacing; SDK also retries 429s
  }

  console.log(`[signature] DONE. drafted ${processed} this run, cumulative spend $${spend.toFixed(4)}.`);
  writeApplySql(loadDrafts());
  console.log(`[signature] REVIEW ${DRAFT_PATH}, then apply ${SQL_PATH} to main by hand.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
