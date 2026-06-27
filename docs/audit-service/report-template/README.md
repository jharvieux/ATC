# Audit report renderer

Turns structured findings into a professional, hybrid **PDF** (dashboard cover page +
formal findings body) — driven entirely by data, so every engagement gets an identical
polished artifact.

## Pipeline
`findings.json` (data)  →  `render.mjs` (HTML+CSS+inline-SVG charts)  →  `report.pdf` (+ `report.html`, `page1.png`)

Uses the repo's existing Playwright (`page.pdf()`) — no new dependency.

## Run
```bash
node docs/audit-service/report-template/render.mjs <findings.json> [outDir]
# example (ATC self-audit):
node docs/audit-service/report-template/render.mjs docs/audit-service/report-template/findings.atc.json
```
Outputs land in `out/` (git-ignored): `report.pdf`, `report.html`, `page1.png` (QA screenshot).

## Per engagement
Copy `findings.atc.json` → `findings.<client>.json`, replace `meta` + `findings`. Each finding's
**BFTB** is computed from `value × ease × safety` (1–5 each). The **Action Plan** auto-includes everything
BFTB > 75 plus any Critical/High security finding (excluding already-completed items). Format never changes.

## Schema (per finding)
`id, title, category, severity (Critical|High|Medium|Low|Perf|Info|Watch), value, ease, safety,
taxonomy, location, evidence, impact, fix, status`
