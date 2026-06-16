# Session state — last updated 2026-06-16 (usage 403 fix in flight)

## Just completed
- Fixed the lisa-travel chat "Couldn't load history: HTTP 403" bug (#1170).
  Added shared `SELF_SERVICE_GRANTS` inherited by all three roles. PR #1174
  merged to dev, branch deleted. Logged D-248.

## In flight
- Fix for "Usage under Administration → forbidden" (a #1173 pair surfacing live).
  - Branch: `fix/tenant-usage-owner-grants` (off origin/dev).
  - Root cause: `TenantUsage:read`, `TenantOverrideRequest:list`, `:create` absent
    from the RBAC matrix → fail-closed 403 on /settings/usage for everyone.
  - Fix: granted those 3 pairs to OWNER_GRANTS only (Administration nav is
    OWNER_ONLY; only the owner-only /settings/usage page calls these endpoints).
  - Files: `apps/main/src/lib/auth/permission-grants.ts`,
    `apps/main/test/unit/auth/permission-grants.test.ts` (OWNER_ONLY_PAIRS).
  - `pnpm verify` EXIT 0 (3865 tests pass). Logged D-249.
  - Also carries the D-248 MEMORY entry (was uncommitted, not yet on dev).
  - NEXT: push, open PR with ## Audit placeholder, run d091-reviewer +
    pre-pr-reviewer (Sonnet — small diff, no Opus triggers), fill Audit block,
    wait for CI, squash-merge, delete branch, update #1173.

## Next step
- Push `fix/tenant-usage-owner-grants` and open the PR (see In flight).

## Blocked on user
- Nothing.

## Open questions
- #1173 still has the remaining ungranted pairs (this fix resolves 3 of them).
  Carry-over: confirm release/beta062 deployed + lisa-travel loads (D-247);
  delete hotfix branch hotfix/fetch-branding-null-guard if still present.
