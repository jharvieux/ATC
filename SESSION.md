# Session state — last updated 2026-09-01 06:47 CDT

## Just completed
- Kept the application, development, CI, and Vercel runtime contract on Node 24.x; Vercel does not yet list Node 26 for Builds or Functions.
- Removed the stale Intel Homebrew initialization from `~/.zprofile`, loaded NVM in login shells, selected the nearest `.nvmrc` or the Node 24 default, and prevented duplicate NVM loading from `~/.zshrc`.
- Verified ordinary login and interactive shells resolve Node 24.19.0 from NVM both inside the repository and from `/private/tmp`, without the former Homebrew startup warning.
- Added `.pnpmfile.mjs` plus `scripts/check-node-runtime.mjs`; every pnpm script and dependency-resolution command now stops at repository load unless the executing runtime is Node 24.x.
- Added four intent tests covering Node 24 acceptance, Node 26 rejection with actionable recovery, malformed-version fail-closed behavior, and process-level rejection of a secondary script plus frozen `--ignore-scripts` installation.
- Proved forced Homebrew Node 26 verification, secondary-script, and install entrypoints exit at the pnpmfile runtime guard before substantive work begins.
- Added append-only decisions D-376 and D-377 with their MEMORY index mirrors; D-377 supersedes D-376's initial narrower enforcement mechanism.
- Full `pnpm verify` passed under Node 24.19.0: 631 main files / 7,258 tests and 30 RAG files / 201 tests passed; main/RAG schema drift was explicitly skipped because database URLs are unset.

## In flight
- Nothing in flight — clean verified checkpoint on `feature/enforce-node-24`.

## Next step
- Wait for the user's next request after the Node 24 enforcement PR is finalized. Do not resume the paused issue sweep without an explicit instruction.

## Blocked on user
- The issue sweep remains intentionally paused. Do not resume it unless the user explicitly asks.

## Open questions
- #2112 tracks the pre-existing cross-dimension usage-counter/state-transition crash and concurrency seam outside #2108.
- #2115 tracks staged migration to tenant-scoped Resend idempotency keys after each legacy raw-key window drains for more than 24 hours.
- #2118 tracks the contract migration for legacy `email_log` provider columns after the outbox read switchover is deployed.
- #2119 tracks reconciliation of authenticated access and RLS/table classification on `email_log` and `email_suppressions`.
