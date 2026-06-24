# Day-1 security scan — 2026-06-23

Point-in-time output of the [defending-code-reference-harness](https://github.com/anthropics/defending-code-reference-harness) Day-1 loop (`/threat-model` → `/vuln-scan` → `/triage` → `/patch`), run statically (read-only; no code executed) against `apps/main` and `apps/rag` @ `a1deac27`.

> **Sensitive.** These files enumerate real, confirmed vulnerabilities with exploit reasoning. Keep in the private repo.

## Contents
- `THREAT_MODEL-main.md`, `THREAT_MODEL-rag.md` — threat models (entry points, assets, threats, mitigations).
- `VULN-FINDINGS-{main,rag}.{json,md}` — raw scan candidates (28 main + 10 rag = 38).
- `TRIAGE.{json,md}` — adversarially verified verdicts (14 confirmed real, 16 defense-in-depth LOW, 5 operational, 3 false-positive).
- `PATCHES.md` + `PATCHES/bug_NN_*/patch.diff` — 8 inert candidate diffs (not applied; first-draft, unreviewed by the per-patch reviewer pass).

## Confirmed findings → GitHub issues

| finding | sev | issue | candidate patch |
|---|---|---|---|
| F-pay-01 | HIGH | [#1375](https://github.com/jharvieux/ATC/issues/1375) | bug_01 (fix PR in progress) |
| F-sm-01 | MED | [#1376](https://github.com/jharvieux/ATC/issues/1376) | bug_05 (needs migration) |
| F-sm-02 | MED | [#1377](https://github.com/jharvieux/ATC/issues/1377) | — (needs migration) |
| F-sm-03 | MED | [#1378](https://github.com/jharvieux/ATC/issues/1378) | — |
| F-auth-01 | MED | [#1379](https://github.com/jharvieux/ATC/issues/1379) | — (needs product decision) |
| F-leak-01 | MED | [#1380](https://github.com/jharvieux/ATC/issues/1380) | bug_02 |
| F-ssrf-01 | MED | [#1381](https://github.com/jharvieux/ATC/issues/1381) | bug_04 |
| F-tok-02 | MED | [#1382](https://github.com/jharvieux/ATC/issues/1382) | bug_03 |
| F-rag-pii-02 | MED | [#1383](https://github.com/jharvieux/ATC/issues/1383) | bug_06 |
| F-rag-wh-01 | MED | [#1384](https://github.com/jharvieux/ATC/issues/1384) | bug_07 |
| F-rag-wh-02 | MED | [#1385](https://github.com/jharvieux/ATC/issues/1385) | — |
| F-tok-01 | MED | [#1386](https://github.com/jharvieux/ATC/issues/1386) | — |
| F-inp-02 | MED | [#1387](https://github.com/jharvieux/ATC/issues/1387) | — |
| F-rag-pii-01 | LOW | [#1388](https://github.com/jharvieux/ATC/issues/1388) | — |

The 16 defense-in-depth LOW items and 5 operational/unconfirmed items are listed in `TRIAGE.md` with recommendations (not individually ticketed).

## Method caveats
- Triage used **votes=1** on the 16 MED+HIGH (dedicated adversarial verifier each); LOWs triaged inline against the exclusion rules.
- Candidate patches are **inert and first-draft** — apply via the normal PR flow (`pnpm verify` + d091/pre-pr reviewers).
- Day-1 is the *static* loop. Day-2 (`vuln-pipeline run`) is execution-verified and C/C++-oriented; not applicable to this TS monorepo as-written.
