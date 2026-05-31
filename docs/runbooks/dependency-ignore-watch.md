# Dependency-ignore watch

## The problem this solves

When a dependency major breaks because an upstream package hasn't caught up (e.g. ESLint 10 removed an API that `eslint-plugin-react` still calls), the fix is a `.github/dependabot.yml` `ignore` to hold the major back. But a Dependabot `ignore` is **permanent and silent** — Dependabot never re-proposes the upgrade, and nothing nudges us when the upstream incompatibility clears. The pinned dependency rots indefinitely and nobody remembers why.

This watch closes that gap: a monthly job polls each gating package's published `peerDependencies` and opens a re-test issue when the blocked major becomes admitted.

## How it works

- **Config:** `.github/dependency-ignore-watch.json` — one entry per watched ignore. Each declares the held-back dep (`ignored`), the major we're avoiding (`blocked_major`), the package whose peer range gates the upgrade (`gated_by`), and which peer key to read (`peer_key`).
- **Workflow:** `.github/workflows/dependency-ignore-watch.yml` runs `0 8 1 * *` (08:00 UTC, 1st of each month) + `workflow_dispatch`.
- **Script:** `scripts/check-dependency-ignores.ts` fetches each gating package's latest manifest from the npm registry, reads `peerDependencies[peer_key]`, and asks `isBlockerCleared(range, blocked_major)` (range-intersection via `semver`). When cleared, it opens a deterministically-titled issue labeled `dependency-ignore-watch` (idempotent — skips if one is already open).

## What a "cleared" signal means

A declared `peerDependencies` range is **upstream's claim** of support, not proof the upgrade works. The classic counter-example is already in the config: `vitest` declared `vite: ^8.0.0` support while the JSX-transform break (#330) was still real. So the issue the watch opens is a **re-test trigger**, not an auto-upgrade:

1. On a test branch, remove the ignore from `.github/dependabot.yml`.
2. Run `pnpm verify`.
3. Green → merge the removal, let Dependabot propose the major. Still broken → leave the ignore, comment the new failure, close the issue.

## Adding a new watched ignore

1. Add the `ignore` entry to `.github/dependabot.yml` with a comment explaining the break + the gating package.
2. Add a matching entry to `.github/dependency-ignore-watch.json`:
   ```json
   {
     "ignored": "<dep held back>",
     "blocked_major": <major you're avoiding>,
     "gated_by": "<package whose peerDeps gate the upgrade>",
     "peer_key": "<the peerDependencies key to read>",
     "reason": "<one-line why>",
     "ref": "#<issue/PR>"
   }
   ```
3. That's it — the next monthly run (or a manual `workflow_dispatch`) picks it up.

## Running it manually

```bash
# Local (prints decisions; no issue side-effects without GH_TOKEN):
pnpm tsx scripts/check-dependency-ignores.ts

# Trigger the workflow:
gh workflow run dependency-ignore-watch.yml
```

## Currently watched

| Ignored dep | Blocked major | Gated by | Cleared when |
|---|---|---|---|
| `eslint` | 10 | `eslint-plugin-react` | its `peerDependencies.eslint` admits `^10` |
| `vite` | 8 | `vitest` | its `peerDependencies.vite` admits `^8` (already does — see note below) |

> **Note (2026-05-30):** building this watch surfaced that `vitest@4.1.7` *already* declares `vite: ^6 || ^7 || ^8`. The vite-8 ignore (#330) may be removable now — the declared incompatibility window appears closed. Re-test per the steps above before trusting it; the JSX-transform break was real despite the declared range at the time.
