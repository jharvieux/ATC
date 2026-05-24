# OCR Eval Go/No-Go Rubric

Operator-facing decision rubric for the BP41 OCR evaluation pipeline. The `compare-and-report.ts` script writes a markdown report each run; this rubric tells you what "good enough" means.

## Thresholds (defaults — adjust before running if your tolerances differ)

| Metric | Threshold | Why |
| --- | --- | --- |
| **New-info rate** | **≥ 40%** | OCR must contribute meaningful information (cabin location, venue placement, layout shape) on at least 4 of every 10 images. Below this, the deck-plan text chunks from CruiseMapper already capture enough. |
| **Contradiction rate** | **< 5%** | OCR contradicts the existing chunk text on fewer than 5% of images. Above this, one or both sources are unreliable — investigate before relying on either. |
| **Avg cost per image** | **< $0.05** | Full pass is ~18,000 images. $0.05/image × 18,000 = $900 — operator's stated tolerance ceiling. Above this, cost-deferral kicks in. |

## How to read the report

1. **Headline numbers** at the top. Compare to the thresholds above.
2. **Per-cruise-line breakdown** — if RCL crushes the rubric but Carnival flunks, that's a signal to scope the full pass to specific lines, not blanket.
3. **Sample comparisons** — spot-check the 5 new-info examples. Are they actually useful, or are they hallucinated cabin labels? The aggregate heuristic is keyword-overlap; the operator's eye is the real check.
4. **Contradiction samples** — read carefully. Are they real contradictions (OCR says Deck 8, chunk says Deck 9), or are they ambiguous (multiple decks shown in one image)?

## Operator action

- **GO** (all three thresholds met): proceed to draft the follow-up build prompt that adds OCR to the production ingest pipeline. Capture in MEMORY: the exact go-decision date, the report path, the budget ceiling for the full pass.
- **NO-GO** (any threshold missed): document the call in MEMORY with per-line stats so a future re-eval has a baseline. Note specifically which threshold failed and what would need to change (a better prompt? a different model? lower-resolution input?).
- **MIXED** (one strong, one weak): consider a scoped GO — e.g., "run OCR on the 5 lines where new-info ≥ 60%, skip the rest."

## Tweakability

These thresholds are starting points. Edit them in `compare-and-report.ts` (constants `RUBRIC_UPLIFT`, `RUBRIC_CONTRADICTION`, `RUBRIC_COST`) before running if your tolerances differ — the script reads them at runtime, no rebuild needed.
