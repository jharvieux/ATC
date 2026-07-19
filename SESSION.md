# Session state — last updated 2026-07-19 21:40 HST

## Just completed
- Issue sweep #7 (D-365): 13 PRs merged into dev (#2013 rag-pii-gate, #2015 extension perms, #2016 groups/safeUrl, #2017 format-date TZ, #2020 service-JWT strict flip, #2021 keyset recompute, #2023 precruise structured output + caching, #2024 RAG DB hardening, #2026 kill-switch runbook, #2027 PII datamap, #2029 merge diagnostics, #2036 PII/retention cluster, #2041 final batch). 24 issues closed / 15 filed, net −9.
- Harvey prevention adoption (D-364): PR #2030 — 6 standing guards with baselines, D-091 #27/#28, service-role lint on Inngest paths. Tier 2 = operator-run periodic Harvey engagements. 5 gap issues filed in the Harvey repo.
- Prod-drift P1 cluster resolved by read-only investigation: #1623 + #1927 closed with evidence; #1740 diagnosed to a single 2-statement DDL repair (operator).
- RAG DB: migrations 20260719181701/181740 applied live (operator-approved, ledger recorded) — policy tightening + FK indexes are active server-side.
- Merge-train mechanics documented (D-363) in docs/runbooks/pr-workflow.md.

## In flight
- Nothing in flight — clean checkpoint. All auto-triaged PRs merged; sweep worktrees/branches from THIS session cleaned. (Pre-existing stale worktrees/branches from earlier sessions remain — see Open questions.)

## Next step
- Operator actions below, then normal work resumes. The #2002 strategy-B implementation (service-JWT replaces MAIN_APP_ADMIN_API_KEY) unblocks once the atc-rag prod deploy lands.

## Blocked on user
1. **#1740 prod DDL repair** (2 statements on atc-main, exact SQL on the issue) — the last prod-drift item; errors recur daily at 04:30 UTC until run.
2. **atc-rag manual prod deploy** (`cd apps/rag && vercel deploy --prod --yes`) — activates the strict JWT verifier (#1843), the PII-gate fix (#2001), and pairs with the already-applied RAG DB migrations.
3. **Prod apply of the three new main-DB migrations** (20260722000028 deny policies, ...29 attribution index, ...30 purge indexes) via the operator-gated pipeline step; note ...30's index build briefly blocks inbound-email ingestion — prefer a low-traffic window.
4. **Extension smoke test**: load unpacked, click Connect, confirm the single-origin permission prompt + cookie read (post-#2015).
5. **#2025 time-boxed check** within ~48h of the next prod deploy: transitional precruise rows with null sent_at outside the re-scan window.

## Open questions
- Alert #103 (js/log-injection) should flip to fixed when dev's next CodeQL analysis runs on the merged tree; verify next session (gh api code-scanning/alerts/103).
- ~18 stale worktrees + ~95 stale remote sweep branches from sessions ≤ #6 linger; a housekeeping pass needs operator sign-off (branch deletion rule).
- Open follow-up issues carrying the sweep's remaining work: #1740, #2014, #2019, #2022, #2025, #2028, #2035 (operator-parked), #2037, #2039, #2040.
