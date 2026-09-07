import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/new-migration.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "new-migration-"));
  tempDirs.push(repo);
  mkdirSync(path.join(repo, "apps/main/supabase/migrations"), { recursive: true });
  expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
  return repo;
}

const RAW_DIAGNOSTIC = "UNIQUE_RAW_MKDIR_DIAGNOSTIC";

function installShims(repo: string): string {
  const bin = path.join(repo, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "date"), `#!/usr/bin/env bash
printf '%s' '20260906120000'
`);
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(path.join(bin, "mkdir"), `#!/usr/bin/env bash
target="\${@: -1}"
if [[ "$1" != "-p" ]]; then
  printf '%s\n' "$target" >> "$MKDIR_ATTEMPT_LOG"
  if [[ -n "$MKDIR_FAILURE" ]]; then
    printf '%s\n' '${RAW_DIAGNOSTIC}' >&2
    if [[ "$LC_ALL" != "C" ]]; then
      printf 'mkdir: localized diagnostic\n' >&2
      exit 1
    fi
    case "$MKDIR_FAILURE" in
      permission) printf 'mkdir: %s: Permission denied\n' "$target" >&2 ;;
      parent-path) printf 'mkdir: %s: Not a directory\n' "$target" >&2 ;;
      filesystem) printf 'mkdir: %s: Read-only file system\n' "$target" >&2 ;;
      *) exit 2 ;;
    esac
    exit 1
  fi
fi
exec /bin/mkdir "$@"
`);
  for (const command of ["date", "sleep", "mkdir"]) {
    chmodSync(path.join(bin, command), 0o755);
  }
  return `${bin}:${process.env.PATH ?? ""}`;
}

function run(repo: string, env: Record<string, string>) {
  return spawnSync("bash", [SCRIPT, "main", "test_migration"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("new-migration.sh reservation failures", () => {
  it("retries only an EEXIST collision and advances the floor with a constant clock", () => {
    const repo = setupRepo();
    const lock = path.join(repo, ".git/migration-locks/main/20260906120000");
    const attempts = path.join(repo, "mkdir-attempts");
    mkdirSync(lock, { recursive: true });
    const result = run(repo, {
      PATH: installShims(repo),
      MKDIR_ATTEMPT_LOG: attempts,
      MKDIR_FAILURE: "",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("already reserved");
    expect(result.stdout).toContain("Version: 20260906120001");
    expect(readFileSync(attempts, "utf8").trim().split("\n")).toHaveLength(2);
    const migration = path.join(repo, "apps/main/supabase/migrations/20260906120001_test_migration.sql");
    expect(readFileSync(migration, "utf8")).toContain("Version:   20260906120001");
  });

  it.each([
    ["permission", "permission"],
    ["filesystem", "filesystem"],
  ])("fails immediately on %s even when the candidate exists", (failure, failureClass) => {
    const repo = setupRepo();
    const candidate = path.join(realpathSync(repo), ".git/migration-locks/main/20260906120000");
    const attempts = path.join(repo, "mkdir-attempts");
    mkdirSync(candidate, { recursive: true });
    const result = run(repo, {
      PATH: installShims(repo),
      MKDIR_ATTEMPT_LOG: attempts,
      MKDIR_FAILURE: failure,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`Could not reserve migration version at ${candidate}: ${failureClass}\n`);
    expect(result.stderr).not.toContain("retrying");
    expect(result.stderr).not.toContain(RAW_DIAGNOSTIC);
    expect(result.stdout).toBe("");
    expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual([candidate]);
  });

  it("classifies a parent-path failure immediately without leaking raw diagnostics", () => {
    const repo = setupRepo();
    const candidate = path.join(realpathSync(repo), ".git/migration-locks/main/20260906120000");
    const attempts = path.join(repo, "mkdir-attempts");
    const result = run(repo, {
      PATH: installShims(repo),
      MKDIR_ATTEMPT_LOG: attempts,
      MKDIR_FAILURE: "parent-path",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`Could not reserve migration version at ${candidate}: parent-path\n`);
    expect(result.stderr).not.toContain(RAW_DIAGNOSTIC);
    expect(result.stdout).toBe("");
    expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual([candidate]);
  });
});
