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

function installShims(repo: string, deniedPath?: string): string {
  const bin = path.join(repo, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "date"), `#!/usr/bin/env bash
if [[ -f "$DATE_STATE" ]]; then
  printf '%s' '20260906120001'
else
  printf '%s' '20260906120000'
  : > "$DATE_STATE"
fi
`);
  writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  if (deniedPath) {
    writeFileSync(path.join(bin, "mkdir"), `#!/usr/bin/env bash
target="\${@: -1}"
if [[ "$target" == "$DENIED_PATH" && "$1" != "-p" ]]; then
  echo "mkdir: permission denied" >&2
  exit 1
fi
exec /bin/mkdir "$@"
`);
  }
  for (const command of ["date", "sleep", ...(deniedPath ? ["mkdir"] : [])]) {
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
  it("retries an exact existing candidate directory and preserves the next version", () => {
    const repo = setupRepo();
    const lock = path.join(repo, ".git/migration-locks/main/20260906120000");
    mkdirSync(lock, { recursive: true });
    const result = run(repo, {
      PATH: installShims(repo),
      DATE_STATE: path.join(repo, "date-state"),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("already reserved");
    expect(result.stdout).toContain("Version: 20260906120001");
    const migration = path.join(repo, "apps/main/supabase/migrations/20260906120001_test_migration.sql");
    expect(readFileSync(migration, "utf8")).toContain("Version:   20260906120001");
  });

  it("fails immediately on permission denial and reports the candidate path and class", () => {
    const repo = setupRepo();
    const candidate = path.join(realpathSync(repo), ".git/migration-locks/main/20260906120000");
    const result = run(repo, {
      PATH: installShims(repo, candidate),
      DATE_STATE: path.join(repo, "date-state"),
      DENIED_PATH: candidate,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Could not reserve migration version at ${candidate}: permission`);
    expect(result.stderr).not.toContain("retrying");
    expect(result.stdout).toBe("");
  });
});
