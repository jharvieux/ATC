# Session state — last updated 2026-06-02 ~04:50 PT

## Just completed
- **Autonomous Phase-B security sweep — queue drained.** Everything workable
  files-only (no live-DB apply, no external secrets) is shipped or surfaced.
- **PR #581 (#571 CI shell injection) MERGED to dev (d8e7f2e).** `reason` moved to
  step-level `env:` in deploy.yml (both test-scope echo steps); fail-closed allowlist
  `isCiPathSafe` extracted to `scripts/lib/ci-path-safe.mjs` + unit test. Both audit
  agents clean. Honest finding recorded: the `files` splat was already mitigated by
  per-path single-quoting; the real vector was `reason`. Logged as D-134.
- Earlier this session: **PR #580 (#545 least-privilege grants, file-only) MERGED
  (3e37d95)** and **PR #579 (#547/#548/#549/#550 DB security migrations, file-only)
  MERGED (02e104e).**
- **Nightly-failure triage posted.** #576 (2026-06-02) and #532 (2026-06-01) fail on
  the identical assertion (`rls.test.ts §12.2 duplicate contact_relationship → 23505`).
  Files-only diagnosis commented on #576 (cross-linked #532): schema is correct,
  fixtures are per-run (so NOT a stale-leak) — needs test-DB access to capture the real
  error and confirm the UNIQUE constraint is applied in the nightly DB.

## In flight
- Nothing in flight — clean checkpoint. On `dev`, fast-forwarded to d8e7f2e.
  Working tree carries only non-code noise: `.claude/scheduled_tasks.lock`
  (harness-managed) and untracked `apps/main/supabase/config.toml` (abandoned docker
  attempt — do NOT stage or delete).

## Next step
- Resume from the "Blocked on user" list once the user is back. No autonomous
  engineering work remains in the queue.

## Blocked on user
- **#576 + #532 (nightly failure):** needs test-DB access to capture the actual
  assertion error and verify the `contact_relationships` UNIQUE constraint exists in
  the nightly DB. Most likely schema drift (constraint not applied) — see #576 comment.
- **#546 (grants-snapshot tooling + CI drift check):** needs a live-DB-generated
  baseline (mirrors `rls:snapshot`) AND a deploy.yml change (CI/CD sign-off, incl.
  block-vs-warn posture). Can't do files-only. Documented in PR #580 body.
- **#572 (nonce-based CSP):** larger security enhancement (middleware/layout nonce
  propagation, report-only → enforce). Needs scope/sequencing call — not started blind.
- **#553 leftover:** xlsx (HIGH severity, no npm fix path) + uuid (lhci two-major
  bump) — left OPEN for a user decision. Next.js/qs already shipped.
- **#555 (duplicate migration version 20260528000000):** needs a migration-FILE
  rename — requires explicit permission before touching.
- **#455 / task #52 (active_persona_id FK):** not actionable — no `personas` table
  exists, so the FK migration would fail on apply. #455 already tracks it.
- **#45 (#563+#562 cross-tenant probe):** needs a seeded 2-tenant Supabase test
  project + CI secrets (CROSS_TENANT_FIXTURES / APP_BASE_URL).
- **#47 (#514 unsigned-cookie legacy path):** time-gated — safe no earlier than ~2026-06-30.
- **#534 / #533:** need DB_URL secret / a real staging DB (external provisioning).
- **Ops/secrets (#521, #518, #500, #473):** needs-human-fix, outside Claude Code.

## Open questions
- Nightly §12.2 root cause: if the UNIQUE constraint is confirmed present in the
  nightly DB, the cause shifts to a non-23505 error on the second insert — would need
  the raw error string to chase further.
- DAST tier-2 install still DEFERRED. All DAST local/staging only, never prod.
- Switch model back to Sonnet (`/model claude-sonnet-4-6`) — this session ran on Opus.
