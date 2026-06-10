# Session state — last updated 2026-06-10 20:50 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.

## Just completed
- PR #958 merged (fixes #926 audit timestamp fallback, #948 rag 503, #951 backfill halt alert)
- **PR #959 merged — #780 canonical cruise catalog Phase 1** (see MEMORY D-203): 5 expand migrations (applied to dev Supabase via MCP), admin CRUD UI, scraper cutover, ship_class persistence. Six audit rounds; CI build caught Next 15 async-params; RLS snapshot + rls-exceptions hand-updated (local .env.local DB ≠ CI DB — never regenerate snapshots locally).
- **PR #964 merged — #961 signup form fixes**: sub_host option hidden, red per-field required validation. Rendering-test gap tracked in #966.
- Issues created from operator onboarding review: #960, #961 (closed), #962, #963. Plus #966 (rendering-test stack gap), #969 (platform-tenant customer role discrepancy: dev data shows tenant_owner, design says viewer).

## In flight
- **PR #967 (#962 tenant landing shell)** — audits clean (Opus), body Status PASS, auto-merge enabled; waiting on CI.
- **PR #968 (#960 onboarding activation guidance)** — audit warnings fixed in commit 4ac42c13 (truthful ordering rationale, recipient-read error surfaced, slug href guard); re-audit agents running; then body update + auto-merge. Deferral #965 (first-sign-in checklist) exists.
- **#963 (tenant email templates) worker agent still building** in worktree; will open a PR with migration (NOT to be applied to any DB without operator gate).
- MEMORY.md D-203 + this SESSION.md going out on a chore PR (doc-only, audit-exempt).

## Next step
1. When #968 re-audits post: update its Audit section + Status line, enable auto-merge.
2. When #963 worker reports: run Opus audits (migration + new routes), fix findings, merge.
3. Confirm #967/#968 merged; delete worker worktrees if left behind.
4. Surface to operator: #967 product defaults (support chat = customer /chat; staff default panel; nav mapping; hamburger Admin → /settings) and #969 role question.

## Blocked on user
- OPERATOR GATE: prod apply of #780 migrations (PR #959 merged to dev; prod untouched)
- OPERATOR GATE: #963's migration when its PR lands (dev apply also pending — do not auto-apply)
- #969: intended role for platform-tenant customers (viewer vs tenant_owner) + prod data check
- Test/staging Supabase project provisioning (#386)

## Open questions
- #967 shipped with four flagged product defaults (in PR body) — operator may want to adjust
- Port seeding name-match join (ports ↔ port_info_chunks) still unvalidated against runtime CruiseMapper name formats
