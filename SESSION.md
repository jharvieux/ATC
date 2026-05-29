# Session state — last updated 2026-05-29 ~02:30 UTC

## Just completed

Three PRs merged to dev this session (all squash, branches deleted):

- **PR #388** — test-integrity quick wins: github-closure → real `verifyGitHubSignature` import (extracted to `apps/main/src/lib/webhooks/github-signature.ts`); Stripe nightly secrets (`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` placeholders) added to `nightly-full-test.yml`; RAG scope-isolation documented as deferred; #384 reimplementation catalog comment posted.
- **PR #389** — docs: MEMORY.md **D-113** + SESSION.md checkpoint.
- **PR #390** — docs(CLAUDE.md): added a concrete "how to write to it" recipe for the `block-spec-memory-edits.mjs` append-only hook (Edit: `new_string` must end with `old_string`, anchor on current top entry's header; Write: new content must end with current file verbatim) + a note that SESSION.md is the opposite (plain whole-file overwrite, no hook). Requested by the user after repeated MEMORY.md write friction this session. Read the hook source directly to make the recipe accurate.

No MEMORY.md entry for #390 — once it's in CLAUDE.md it's documented there; a D-entry would be log noise.

Verification: `pnpm verify` green before each push (lint + slop clean, tests pass). All required checks green on all three PRs.

## In flight

- **This SESSION.md refresh** (`docs/session-2026-05-29-eos`): standalone EOS checkpoint, being pushed + opened + merged now. If you're reading this and it is NOT merged, finish that first (CI green → squash → delete branch).
- Otherwise nothing in flight — dev at 491feb6 + this PR, synced with origin.

## Next step

1. **Switch the model back to Sonnet** — this session ran on Opus. Run `/model claude-sonnet-4-6` (the agent cannot invoke `/model` itself).
2. Nothing else pending from this thread. Pick up from the backlog / blocked-on-user items below when ready.

## Blocked on user

- **Operator follow-ups from D-112 (unchanged, still open):** re-point the `supabase-main` MCP server (still on the deleted ref `ucypskudkmzjphixsshx` → new `mfaknjyqiwcjojukcnea`); production redeploy so the new DB takes effect in prod.
- **Issue #386** — dedicated test Supabase project (main AND now RAG) before customer data lands; user routes timing. Also blocks wiring the RAG scope-isolation suite (per D-113).
- Counsel sign-off (P4 #37–#43) and operator decisions (P4 #48–#55) — unchanged.

## Open questions

- **#384** test-rewrite backlog — the 7 Class A reimplementations remain (largest: `crm/contacts.test.ts`). No action pending; tracked.
- **#366** docs(session) D-106/D-107 — still open, likely BEHIND. D-106/D-107 may still be absent from dev's MEMORY.md (stuck in that PR). Needs an `## Audit` section + update-branch + merge.
- **Dependabot PRs** — check open dependabot PR merge state / `regression-suspected` label (retry workflow handles CI; don't intervene unless flagged).
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
