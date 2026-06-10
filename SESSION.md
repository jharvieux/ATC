# Session state — last updated 2026-06-10 22:30 CT

## Standing rule (operator, 2026-06-10 — saved to auto-memory)
**No prod DB changes (MCP migrations/DDL) or manual prod deploys without per-instance operator approval.** Dev-merge → pipeline deploys remain autonomous per CLAUDE.md.

## Just completed
- **#913 merged** (PR #916) — conversations list auth_user_id→public.users.id filter fix.
- **#917 merged** — #903 voice profiles (samples, Haiku style-card extraction w/ hash guard, resolver, settings page, CRUD routes). Migration applied to prod (pre-rule).
- **#920 merged (grants fix)** — #917 shipped tables with RLS but NO DML grants → feature dead at the privilege layer + grants-drift CI blocked every PR. Grants migration (mirrors RLS, rag_submissions convention) applied to prod WITH operator approval; both snapshots regenerated from live via the real generators. Opus audits clean both ways (grants neither exceed nor fall short of RLS).
- Lesson encoded: **a migration PR must regenerate db/rls-snapshot-main.sql AND db/grants-snapshot-main.sql in the same PR** — and new tables need explicit GRANTs; RLS alone leaves authenticated denied at the privilege layer.

## In flight — merge queue (in order)
1. **PR #915** (#866 streaming hard-gate; also carries an RLS snapshot commit — content identical to #920's, merges clean). Update-branch → repost audit comments → `gh run rerun` failed audit check (comments fetched live on rerun; body already has ## Audit) → merge.
2. **PR #914** (#906 help_ai grounding) — same dance. MUST merge before #919 (D-197 references it as merged).
3. **PR #918** (#881 panel asset markers) — same dance.
4. **PR #919** (checkpoint with D-197 + this SESSION; doc-only → audit-exempt) — merge last.

## Blocked on user
- #899 Vercel Hobby → Pro upgrade — blocks #894 cron migration.
- PR #869 (stale June 8 checkpoint, DIRTY) — recommended close; awaiting OK.
- #908 (security: conversations RLS tenant-level) — needs top-tier design session.

## Open questions
- pr-audit-section-check repeatedly fails after update-branch (comments stale vs new head). Current procedure: repost latest marker comments, then rerun the failed check. If this keeps burning cycles, consider a workflow tweak — would need its own PR + operator awareness.
- Prior items: #890, #885, #857, #851, #898 (dependabot retry).
