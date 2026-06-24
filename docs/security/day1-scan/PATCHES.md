# Candidate patches — ATC Day-1 (static mode)

**Inert diffs for human review — NOT applied.** Each was produced by an independent patch subagent (read-only, root-cause-first, variant-hunt, adversarial self-check, regression test). Review and apply out-of-band; run `pnpm verify` before merging. Diffs use abbreviated context where a subagent's read was compressed — treat them as guides, regenerate exact hunks on apply.

Generated for **8 of the 14 confirmed findings** — the HIGH + 7 representative cases spanning each distinct fix class. The remaining confirmed findings keep ready-to-apply recommendations in `TRIAGE.json`.

| bug | finding | sev | file(s) | fix class | notes |
|---|---|---|---|---|---|
| bug_01 | F-pay-01 | HIGH | bookings/[id]/cancel/route.ts | financial CAS | status-CAS claims the payout row before the reversal+ledger insert; 409 on race. `reversed` status + `reversed_at` already exist (migration 20260703000000). |
| bug_02 | F-leak-01 | MED | chat/route.ts | error sanitization | both SSE error sinks (catch + line-460 interpolation) → generic message + server-logged `ref`. |
| bug_03 | F-tok-02 | MED | public/chat/[token]/route.ts + resolver | authz status-gate | new `isPublicTokenViewable` predicate (sent/viewed quotes; sent itineraries) gates before PII load; 410 on stale. +unit test. |
| bug_04 | F-ssrf-01 | MED | new lib/net/ssrf-guard.ts; travel-news-refresh.ts; feeds route | SSRF guard | scheme allowlist + private-IP block + manual-redirect re-validation at ingest and fetch. +unit test. Residual: DNS-rebinding noted. |
| bug_05 | F-sm-01 | MED | new migration + lib/chat/customer-limit.ts | atomic counter | atomic increment RPC (consume-then-check + refund), mirrors increment_tenant_ai_cost. Needs DB migration → **prod-gated**. |
| bug_06 | F-rag-pii-02 | MED | new packages/contracts/src/safe-url.ts + 5 schemas | input validation | shared `safeUrl` zod (http/https + private-host deny) swapped into all 6 stored-URL fields. +recommended test. |
| bug_07 | F-rag-wh-01 | MED | feedback/route.ts + feedback-limit.ts | auth ordering | verify HMAC before rate-limit; re-key bucket on verified message_id, drop spoofable XFF. +test update. |
| bug_08 | F-rag-auth-02 | LOW | 5 rag admin routes | scope check | add `scope==='write'` guard (matches replace-chunk precedent) to destructive admin routes. |

## How to apply

1. Review each `PATCHES/bug_NN_*/patch.diff` against the cited files (the working-tree code may have moved since the scan; line numbers are approximate).
2. Apply by hand or regenerate the exact hunk, then `pnpm verify`.
3. **bug_05 ships a SQL migration** → it touches the prod DB; per repo policy that needs operator approval before apply (no prod migrations without asking). The expand/atomic-RPC is additive (safe expand), but still gated.
4. Add the regression tests the subagents specced (each finding's "tests verify intent" note) — several flag that a sanitizer without a test silently regresses.

## Not patched here (recommendations live in TRIAGE.json)

Confirmed but left for a follow-up patch run: F-sm-02 (anon-limit, same RPC pattern as bug_05), F-sm-03 (AI-cost cache freshness), F-auth-01 (OTP session-binding — needs a product decision on the flow), F-tok-01 (public-chat Redis limiter), F-inp-02 (decompression budget), F-rag-wh-02 (feedback replay nonce), plus the 16 LOW/defense-in-depth items (error-sanitization sweep, IDOR ownership checks, tenant-scoping, audit wrappers, PII-prefilter normalization, etc.).

## Important

These candidate patches were **not** run through the skill's independent per-patch reviewer pass (Phase 3) — to bound cost at this scale. They are first-draft candidates. Before merging any of them, run the normal PR flow (`pnpm verify` + the d091-reviewer / pre-pr-reviewer agents), which is where they'd get the second set of eyes.
