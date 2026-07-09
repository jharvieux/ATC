#!/usr/bin/env node
// Stop hook: surfaces the migrations runbook whenever the branch touches a
// migration or snapshot file — the "durable can't-forget" backstop for
// CLAUDE.md's migration stop-rule (#1536; option 3b, agreed 2026-06-27).
//
// Why: the stop-rule is a passive instruction ("STOP and follow
// docs/runbooks/migrations.md") that relies on the agent noticing migration
// files in its own diff. Under context pressure that's exactly the kind of
// step that gets skipped — this makes the reminder unmissable instead of
// hoped-for.
//
// Trigger: any path matching `**/supabase/migrations/` or `db/*snapshot*.sql`
// in EITHER (a) the working tree (`git status --porcelain`, catches
// mid-session) or (b) commits already made on this branch but not yet pushed
// (`git diff` against the upstream, or origin/dev if no upstream is set yet —
// catches the actual pre-push moment, e.g. resuming a session where the
// migration was committed last turn).
//
// Non-blocking by design (v1, per the issue): this prints and exits 2 so the
// message reaches the agent as Stop-hook feedback (same mechanism as the
// typecheck/test Stop hooks), but CLAUDE.md's Stop-hook-feedback section
// treats that as background telemetry, not a blocker — the agent isn't
// required to reply, only to act on it when genuinely relevant, which a
// migration diff always is.
//
// Wired in .claude/settings.json under hooks.Stop.

import { execSync, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try { readFileSync(0, "utf-8"); } catch {}

function isMigrationPath(p) {
  return /(^|\/)supabase\/migrations\//.test(p) || /^db\/.*snapshot.*\.sql$/.test(p);
}

function workingTreePaths() {
  try {
    const raw = execSync("git status --porcelain --untracked-files=normal", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split("\n")
      .map((line) => line.replace(/^...\s*/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function unpushedCommitPaths() {
  const tryDiff = (range) => {
    try {
      return execFileSync("git", ["diff", "--name-only", range], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return null;
    }
  };
  return (
    tryDiff("@{u}...HEAD") ?? tryDiff("origin/dev...HEAD") ?? []
  );
}

const touched = [...new Set([...workingTreePaths(), ...unpushedCommitPaths()])];
if (!touched.some(isMigrationPath)) process.exit(0);

process.stderr.write(
  "Migration diff detected (Stop hook) — follow docs/runbooks/migrations.md before opening/updating the PR:\n\n" +
    "  0. Generate versions with scripts/new-migration.sh <main|rag> <slug> — never hand-pick one (#1660/#1661).\n" +
    "  1. A policy/grant change needs the matching snapshot regenerated in THIS PR (pnpm rls:snapshot:<app> / pnpm grants:snapshot).\n" +
    "  2. Regenerate snapshots against the test DB (SUPABASE_TEST_DB_URL) — never hand-write them.\n" +
    "  3. No CREATE INDEX CONCURRENTLY in a multi-statement migration.\n" +
    "  4. Don't pre-apply a migration that isn't on a pushed branch — it orphans the shared test-DB ledger.\n" +
    "  7. Destructive migrations ship AFTER the read-switchover, in their own PR (expand -> switch -> contract).\n\n" +
    "Full checklist: docs/runbooks/migrations.md\n",
);
process.exit(2);
