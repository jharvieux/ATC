# Session state — last updated 2026-06-24 00:30 PT

## Just completed
- #1361 closed (self-heal shipped #1362; gated on operator config #1365). #1369 closed not-planned (D-295). PR #1374 merged.
- Ran the defending-code-reference-harness **Day-1 static loop** on apps/main + apps/rag. Installed the one uninstalled harness update first (`_lib/checkpoint.py` was stale + interface-broken). 38 candidates → 14 confirmed real (D-296).
- Opened 14 issues #1375-#1388 (severity + opus/sonnet + security + triage:confirmed).
- Committed scan artifacts under `docs/security/day1-scan/` (branch `docs/day1-security-scan` → doc-only PR).

## In flight
- Branch `docs/day1-security-scan`: docs/security/day1-scan/** + MEMORY D-296 + index + SESSION. Doc-exempt. Needs push + PR + merge.
- NEXT after that: branch `fix/f-pay-01-clawback-cas` for the F-pay-01 (#1375) code-only fix (payout-row status-CAS before the reversal+ledger insert; `reversed` status already exists, no migration) + regression test → full PR (pnpm verify + d091/pre-pr audit agents, Opus first run — financial path).

## Next step
- Push docs branch, open + merge the doc-only PR. Then implement and PR the F-pay-01 fix.

## Blocked on user
- #1365: operator bump of Supabase `refresh_token_reuse_interval` 10s→30s (prod dashboard).
- F-sm-01 (#1376) / F-sm-02 (#1377) fixes ship SQL migrations → prod-gated (need approval).
- F-auth-01 (#1379) needs a product decision on the OTP/identity-binding flow.

## Open questions
- Whether to generate patches + PRs for the remaining confirmed findings (recommendations are in TRIAGE.json).
