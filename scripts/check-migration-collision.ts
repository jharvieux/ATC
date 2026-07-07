// Migration-version collision gate (#1660/#1661).
//
// Two independent failure modes, both DB-free:
//
//   1. SAME-APP DUPLICATE — two migration files in the same app's migrations
//      directory share a version (the numeric prefix before the first `_`).
//      Catches an accidental duplicate landing in one branch/PR, or a rebase
//      that pulled in a file the branch already had under a different name.
//
//   2. BRANCH-VS-DEV COLLISION — a migration this branch ADDS has a version
//      that already exists on origin/<base> under a DIFFERENT filename. This
//      is the #1660 incident shape: N parallel agents each derive the same
//      "next" version from the same dev snapshot; the first PR to merge wins
//      the shared test DB ledger row, every sibling PR's migration then
//      collides. Catching it here (file-name diff) is cheaper and faster than
//      the DB-based ledger pre-check in deploy.yml's rls-snapshot-diff job,
//      which is the authoritative backstop for the residual cross-machine
//      race this script can't see (two branches that haven't been diffed
//      against each other yet).
//
// Usage:
//   tsx scripts/check-migration-collision.ts
//   MIGRATION_COLLISION_BASE_REF=origin/release/x tsx scripts/check-migration-collision.ts
//
// Exit 0 if no collision (or nothing to check). Exit 1 on any violation. A
// git-diff/ls-tree failure (e.g. base ref not fetched) is a warning + exit 0 —
// never block a PR on CI plumbing; the DB-based ledger pre-check still gates.
//
// Baseline: db/migration-collision-baseline.txt lists exact
// `<app>:<version>:<sorted,comma,joined,filenames>` keys accepted as
// pre-existing debt (same spirit as scripts/d091-baseline.txt). The full file
// list is part of the key — not just app:version — so a THIRD file later
// landing at an already-baselined version is a NEW violation, not silently
// absorbed into the baselined pair. Only same-app duplicates are ever
// pre-existing (a branch-vs-dev collision can't predate the branch that
// creates it), so the baseline only suppresses findDuplicatesInApp violations.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = process.env.MIGRATION_COLLISION_BASE_REF ?? "origin/dev";
const BASELINE_FILE = path.join(REPO_ROOT, "db", "migration-collision-baseline.txt");

const APPS = ["main", "rag"] as const;
type App = (typeof APPS)[number];

export interface DuplicateViolation {
  kind: "duplicate-in-app";
  app: App;
  version: string;
  files: string[];
}

export interface BranchVsDevViolation {
  kind: "branch-vs-dev";
  app: App;
  version: string;
  branchFile: string;
  devFile: string;
}

export type Violation = DuplicateViolation | BranchVsDevViolation;

// A migration filename is `<version>_<slug>.sql`; version is the leading run
// of digits before the first underscore (main: 14-digit timestamp, rag: the
// old 4-digit sequential prefix — both share the identical collision shape).
export function parseVersion(filename: string): string | null {
  const m = filename.match(/^(\d+)_.+\.sql$/);
  return m ? m[1]! : null;
}

// Pure core #1: given every migration filename currently present for an app,
// return groups whose version collides.
export function findDuplicatesInApp(app: App, filenames: string[]): DuplicateViolation[] {
  const byVersion = new Map<string, string[]>();
  for (const f of filenames) {
    const v = parseVersion(f);
    if (!v) continue;
    const list = byVersion.get(v) ?? [];
    list.push(f);
    byVersion.set(v, list);
  }
  const violations: DuplicateViolation[] = [];
  for (const [version, files] of byVersion) {
    if (files.length > 1) {
      violations.push({ kind: "duplicate-in-app", app, version, files: files.sort() });
    }
  }
  return violations;
}

// Pure core #2: given the migration filenames this branch ADDS and the
// migration filenames that exist on the base ref, flag any added file whose
// version matches a base-ref file under a different name.
export function findBranchVsDevCollisions(
  app: App,
  addedFilenames: string[],
  devFilenames: string[],
): BranchVsDevViolation[] {
  const devByVersion = new Map<string, string>();
  for (const f of devFilenames) {
    const v = parseVersion(f);
    if (v && !devByVersion.has(v)) devByVersion.set(v, f);
  }

  const violations: BranchVsDevViolation[] = [];
  for (const branchFile of addedFilenames) {
    const v = parseVersion(branchFile);
    if (!v) continue;
    const devFile = devByVersion.get(v);
    if (devFile && devFile !== branchFile) {
      violations.push({ kind: "branch-vs-dev", app, version: v, branchFile, devFile });
    }
  }
  return violations;
}

// Exported for tests. Format: `<app>:<version>:<sorted,comma,joined,files> # reason`.
// Blank lines and `#`-prefixed comment lines are ignored.
export function readBaseline(text: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const key = line.split("#")[0]!.trim();
    if (key) keys.add(key);
  }
  return keys;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return readBaseline(fs.readFileSync(BASELINE_FILE, "utf8"));
}

function migrationsDir(app: App): string {
  return path.join(REPO_ROOT, "apps", app, "supabase", "migrations");
}

function listWorkingTreeMigrations(app: App): string[] {
  const dir = migrationsDir(app);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
}

// Migration files this branch ADDS relative to BASE_REF (diff-filter=A only —
// a renamed or modified pre-existing migration isn't a "new" version claim).
function addedMigrationsVsBase(app: App): { files: string[]; ok: boolean } {
  const prefix = `apps/${app}/supabase/migrations/`;
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=A", `${BASE_REF}...HEAD`],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    const files = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(prefix) && l.endsWith(".sql"))
      .map((l) => l.slice(prefix.length));
    return { files, ok: true };
  } catch {
    return { files: [], ok: false };
  }
}

// Migration filenames present on BASE_REF (via git ls-tree — no checkout
// needed, works whether or not BASE_REF has been fetched into a local branch).
function devMigrations(app: App): { files: string[]; ok: boolean } {
  const dir = `apps/${app}/supabase/migrations`;
  try {
    const out = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", BASE_REF, "--", dir],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    const files = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".sql"))
      .map((l) => path.basename(l));
    return { files, ok: true };
  } catch {
    return { files: [], ok: false };
  }
}

function main(): void {
  const baseline = loadBaseline();
  const violations: Violation[] = [];
  let gitOk = true;

  for (const app of APPS) {
    const duplicates = findDuplicatesInApp(app, listWorkingTreeMigrations(app)).filter(
      (v) => !baseline.has(`${v.app}:${v.version}:${v.files.join(",")}`),
    );
    violations.push(...duplicates);

    const added = addedMigrationsVsBase(app);
    const dev = devMigrations(app);
    if (!added.ok || !dev.ok) {
      gitOk = false;
      continue;
    }
    if (added.files.length === 0) continue;
    violations.push(...findBranchVsDevCollisions(app, added.files, dev.files));
  }

  if (!gitOk) {
    console.warn(
      `migration-collision guard: could not compute git diff/ls-tree against ${BASE_REF} — ` +
        "skipping the branch-vs-dev check (same-app duplicate check still ran; the DB-based " +
        "ledger pre-check in deploy.yml still gates).",
    );
  }

  if (violations.length === 0) {
    console.log("migration-collision guard: ok — no colliding migration versions.");
    return;
  }

  console.error("migration-collision guard: colliding migration version(s) detected.\n");
  for (const v of violations) {
    if (v.kind === "duplicate-in-app") {
      console.error(
        `  [${v.app}] version ${v.version} is used by ${v.files.length} files in the same migrations dir:\n` +
          v.files.map((f) => `    - ${f}`).join("\n") +
          `\n    Fix: regenerate one of them with scripts/new-migration.sh ${v.app} <slug>\n`,
      );
    } else {
      console.error(
        `  [${v.app}] version ${v.version} collides with an existing dev migration:\n` +
          `    branch adds: ${v.branchFile}\n` +
          `    already on ${BASE_REF}: ${v.devFile}\n` +
          `    Fix: regenerate the branch's migration with scripts/new-migration.sh ${v.app} <slug> ` +
          "to get a fresh, non-colliding version.\n",
      );
    }
  }
  process.exit(1);
}

// Only run when invoked directly (`tsx scripts/check-migration-collision.ts`);
// importing the module for unit tests must NOT trigger the repo scan or exit.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
