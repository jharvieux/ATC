# Session state — last updated 2026-05-29 ~01:45 UTC

## Just completed

Test-integrity quick wins (PR #388, squash-merged to dev) + this docs PR.

- **PR #388 merged** (squash, branch deleted). Three fixes from the #384 per-file sweep:
  - **github-closure → real import.** Extracted the route's HMAC verifier into `apps/main/src/lib/webhooks/github-signature.ts` (`verifyGitHubSignature`, mirroring `resend-signature.ts`); route + test now import the real function. The test previously reproduced it in-test and downgraded `timingSafeEqual` to `===`. 6/6 pass.
  - **stripe-webhook activation.** Added `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` CI placeholders to `nightly-full-test.yml` so the dead suite runs. It self-signs events + imports the real handler (pure HMAC, no Stripe API), so placeholders suffice. 3/3 pass against the seeded DB locally.
  - **rag scope-isolation deferred.** Documented in-file (gate var set nowhere; only RAG creds point at prod-serving DB; tests 2–5 reimplement auth gates inline). NOT wired.
- **#384 catalog comment posted**: 7 Class A reimplementation files (with line refs) + the two dead suites + verified-legit exclusions (e.g. `money.test.ts`). This is the test-rewrite backlog.
- **D-113 logged** (this docs PR).
- Audits: d091-reviewer clean; pre-pr-reviewer 1 warning (`§32.10.7` citation — verified real) + 2 accepted nits. All 9 required CI checks green on #388. Vercel preview deploys failed on a 24h rate-limit — non-required, did not block.

Verification: `pnpm verify` green (1920 passed / 61 skipped, lint + slop clean); github-closure 6/6 + stripe-webhook 3/3 against the seeded DB.

## In flight

- **This docs PR** (`docs/session-2026-05-29-d113-test-integrity`): carries MEMORY.md D-113 + this SESSION.md. Being pushed + opened + merged now. If you're reading this and it is NOT merged, finish that first.

## Next step

1. Merge this docs PR once CI passes (then delete the branch).
2. **Switch the model back to Sonnet** — this session ran on Opus. Run `/model claude-sonnet-4-6` (the agent cannot invoke `/model` itself).
3. Optional: `workflow_dispatch` `nightly-full-test` to confirm the stripe-webhook suite now runs green end-to-end (placeholders + DB seed are in place; PR CI does not exercise the nightly).

## Blocked on user

- **Operator follow-ups from D-112 (unchanged, still open):** re-point the `supabase-main` MCP server (still on the deleted ref `ucypskudkmzjphixsshx` → new `mfaknjyqiwcjojukcnea`); production redeploy so the new DB takes effect in prod.
- **Issue #386** — dedicated test Supabase project (main AND now RAG) before customer data lands; user routes timing. Now also blocks wiring the RAG scope-isolation suite (per D-113).
- Counsel sign-off (P4 #37–#43) and operator decisions (P4 #48–#55) — unchanged.

## Open questions

- **#384** test-rewrite backlog — the 7 Class A reimplementations remain (largest: `crm/contacts.test.ts`). No action pending; tracked.
- **#366** docs(session) D-106/D-107 — still open, likely BEHIND. D-106/D-107 may still be absent from dev's MEMORY.md (stuck in that PR). Needs an `## Audit` section + update-branch + merge.
- **Dependabot PRs** — at session start, `dependabot/npm_and_yarn/dev-dependencies-*` and `production-minor-patch-*` branches were pushed to origin. Check open dependabot PR merge state / `regression-suspected` label (retry workflow handles CI; don't intervene unless flagged).
- Phase 2 shift-left (Turbo remote cache), `ai_tool_calls` retention policy, Layer-2 cold-read reviewer — unchanged.

## Carried forward (unchanged)

- BP39: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII confidence/clarity scorer (cost-deferred — P3 #32)
- BP30: AI behavior eval harness (cost-deferred — P3 #35)
- BP25: PLATFORM_PEPPER offsite + DO-NOT-ROTATE doc (P4 #46)
- BP24: populate `platform_settings.supervisor_slur_deny_list` (P4 #45)
- BP23: populate `port_info_chunks` for 17 ports (P4 #44)
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer (P4 #41)
- §13.9 active vs reactive health probing — operator decision (P4 #48)
- Booking flow Stages 2/3 (passenger details + options)
- persona-addendum-rescreen flush window (4:30→12:30 UTC) — revisit if approved-addendum count grows
