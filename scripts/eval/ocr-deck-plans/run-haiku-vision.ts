// BP41 §33.5 / §33.11 — Haiku vision OCR runner.
//
// Reads the sample fixture, fetches each image, sends it to Haiku
// vision with a structured prompt, appends one JSONL line per result.
// Resumable: skips asset_ids already in the output file.
//
// Hard $25 cap on Anthropic spend — logged loudly when reached, then
// exits cleanly so the user can rerun later.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const SAMPLE_PATH = "scripts/eval/ocr-deck-plans/sample.json";
const RESULTS_PATH = "scripts/eval/ocr-deck-plans/results.jsonl";
const HARD_CAP_USD = 25;
const HAIKU_MODEL = process.env.ANTHROPIC_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

// Per-token prices for claude-haiku-4-5 as of build (USD per 1M tokens).
// Update if Anthropic publishes a price change.
const PRICE_INPUT_PER_M = 0.80;
const PRICE_OUTPUT_PER_M = 4.00;
const PRICE_IMAGE_PER_K = 1.20; // approximate per 1000 input image tokens

interface SampleEntry {
  asset_id: string;
  image_url: string;
  source_page_url: string;
  cruise_line_or_supplier: string | null;
  ship_or_property: string | null;
}
interface SampleFile { sample: SampleEntry[] }

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

const OCR_PROMPT = `You are looking at a cruise-ship deck plan image.

Describe the deck's layout in structured form. Cover:
1. Overall layout shape (e.g., long with public spaces fore/aft, cabins amidships).
2. Cabin categories visible on this deck — list each category with its location (e.g., "Balcony 6V — port side, mid-ship").
3. Public venues visible (restaurants, bars, theaters, pools, etc.) with their location.
4. Any text legends, color keys, or annotations.
5. Anything else useful for a customer choosing a cabin.

Be concise — under 300 words. If the image is unreadable or doesn't show a deck plan, say so explicitly.`;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY must be set.");
    process.exit(1);
  }
  if (!existsSync(SAMPLE_PATH)) {
    console.error(`Sample file ${SAMPLE_PATH} not found. Run select-sample.ts first.`);
    process.exit(1);
  }
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });

  const sampleFile = JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as SampleFile;
  const sample = sampleFile.sample;

  // Resumability: which asset_ids have we already processed?
  const already = new Set<string>();
  let priorSpend = 0;
  if (existsSync(RESULTS_PATH)) {
    for (const line of readFileSync(RESULTS_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ResultLine;
        already.add(r.asset_id);
        priorSpend += r.cost_usd ?? 0;
      } catch { /* ignore corrupt lines */ }
    }
    console.log(`[ocr-eval] resume: ${already.size} already processed, prior spend $${priorSpend.toFixed(4)}`);
  }

  let cumulativeSpend = priorSpend;
  let processed = 0;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  for (const entry of sample) {
    if (already.has(entry.asset_id)) continue;

    if (cumulativeSpend >= HARD_CAP_USD) {
      console.error(`[ocr-eval] HARD CAP $${HARD_CAP_USD} reached (spent $${cumulativeSpend.toFixed(4)}). Exiting.`);
      process.exit(0);
    }

    const result = await processOne(client, entry);
    appendFileSync(RESULTS_PATH, JSON.stringify(result) + "\n");
    cumulativeSpend += result.cost_usd ?? 0;
    processed += 1;
    if (processed % 10 === 0) {
      console.log(`[ocr-eval] processed ${processed}/${sample.length - already.size} new, spend $${cumulativeSpend.toFixed(4)}`);
    }

    // Light rate-limit to be polite to Anthropic; the SDK also retries on 429.
    await sleep(250);
  }

  console.log(`[ocr-eval] DONE. processed ${processed} images this run, cumulative spend $${cumulativeSpend.toFixed(4)}`);
}

async function processOne(client: Anthropic, e: SampleEntry): Promise<ResultLine> {
  const ts = new Date().toISOString();
  try {
    // Hot-link directly — Anthropic accepts a `url` source for image blocks.
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 600,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: e.image_url } },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
    });

    const text = resp.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const inputTokens = resp.usage.input_tokens;
    const outputTokens = resp.usage.output_tokens;
    // Vision input tokens are folded into input_tokens by the API; the
    // separate image-pricing constant above is a hedge in case the API
    // bills images separately in a future schema change. For now, use the
    // simple text-token formula and add a fudge factor of $0.001 per image
    // to err high (cap is a hard floor).
    const cost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_M
               + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M
               + 0.001;
    void PRICE_IMAGE_PER_K;

    return {
      asset_id: e.asset_id,
      ok: true,
      output_text: text,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: Number(cost.toFixed(6)),
      cruise_line: e.cruise_line_or_supplier,
      ship: e.ship_or_property,
      image_url: e.image_url,
      source_page_url: e.source_page_url,
      ts,
    };
  } catch (err) {
    return {
      asset_id: e.asset_id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      cruise_line: e.cruise_line_or_supplier,
      ship: e.ship_or_property,
      image_url: e.image_url,
      source_page_url: e.source_page_url,
      ts,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
