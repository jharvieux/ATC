import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const WORKFLOW = resolve(__dirname, "../../../.github/workflows/dependabot-retry-ci.yml");
const tempDirs: string[] = [];

function workflowScript(): string {
  const source = readFileSync(WORKFLOW, "utf8");
  const marker = "        run: |\n";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error("dependabot retry workflow has no run block");
  return source
    .slice(start + marker.length)
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function runWorkflow(failedRerun?: string) {
  const dir = mkdtempSync(join(tmpdir(), "dependabot-retry-ci-"));
  tempDirs.push(dir);
  const log = join(dir, "gh.log");
  const mockGh = join(dir, "gh");
  writeFileSync(
    mockGh,
    `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$MOCK_GH_LOG"
case "$1 $2" in
  "pr list")
    printf '%s\\n' '42 dependabot/npm_and_yarn/test'
    ;;
  "pr checks")
    [[ " $* " == *" --required "* ]] || printf '%s\\n' 'https://github.com/acme/repo/actions/runs/103/job/1'
    [[ "$*" == *'select(.state == "FAILURE")'* ]] && printf '%s\\n' \\
      'https://github.com/acme/repo/actions/runs/101/job/1' \\
      'https://github.com/acme/repo/actions/runs/102/job/2' \\
      'https://github.com/acme/repo/actions/runs/101/job/3'
    exit 8
    ;;
  "run rerun")
    [[ "\${3:-}" == "$MOCK_FAILED_RERUN" ]] && exit 1
    ;;
esac
exit 0
`,
  );
  chmodSync(mockGh, 0o755);
  const result = spawnSync("bash", ["-c", workflowScript()], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      MOCK_GH_LOG: log,
      MOCK_FAILED_RERUN: failedRerun ?? "",
    },
  });
  return { result, calls: readFileSync(log, "utf8") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dependabot retry workflow", () => {
  it("reruns every failed required run when another required check is pending", () => {
    const { result, calls } = runWorkflow();

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(calls).toContain("pr checks 42 --required");
    expect(calls.match(/run rerun 101 --failed/g)).toHaveLength(1);
    expect(calls.match(/run rerun 102 --failed/g)).toHaveLength(1);
    expect(calls).not.toContain("run rerun 103");
  });

  it("tries the remaining runs and fails the job when a rerun request fails", () => {
    const { result, calls } = runWorkflow("101");

    expect(result.status).toBe(1);
    expect(calls).toContain("run rerun 101 --failed");
    expect(calls).toContain("run rerun 102 --failed");
  });
});
