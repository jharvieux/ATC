# BP41 — Haiku vision OCR sample evaluation

A 3-step offline evaluation pipeline that informs the operator decision on whether to fund a full ~18,000-image OCR pass over CruiseMapper deck-plan images.

## Three scripts, run in order

```bash
# 1. Stratified random sample of 200 deck-plan images.
pnpm tsx scripts/eval/ocr-deck-plans/select-sample.ts > scripts/eval/ocr-deck-plans/sample.json

# 2. Run Haiku vision on each. Hard $25 cap; resumes on rerun.
pnpm tsx scripts/eval/ocr-deck-plans/run-haiku-vision.ts

# 3. Compare OCR output to existing text chunks; produce markdown report.
pnpm tsx scripts/eval/ocr-deck-plans/compare-and-report.ts
```

Outputs:
- `scripts/eval/ocr-deck-plans/sample.json` — the 200-image fixture.
- `scripts/eval/ocr-deck-plans/results.jsonl` — one line per image: raw model output + tokens + cost.
- `reports/ocr-eval-YYYY-MM-DD.md` — the human-readable comparison + go/no-go recommendation.

## Required env vars

| Var | Source |
|---|---|
| `SUPABASE_RAG_DB_URL` | RAG service Postgres connection (for asset + chunk reads) |
| `ANTHROPIC_API_KEY` | Haiku vision calls |

## Cost cap

Hard stop at **$25** total Anthropic spend regardless of progress. Logged loudly. Re-run picks up where it left off because each image's result is appended to `results.jsonl` and the run script skips already-processed `asset_id`s.

## Rubric

See [`reports/ocr-eval-rubric.md`](../../../reports/ocr-eval-rubric.md) for the operator-facing go/no-go thresholds.
