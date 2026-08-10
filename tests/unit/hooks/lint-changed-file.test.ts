import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude/hooks/lint-changed-file.mjs");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lint-changed-file.mjs — Codex apply_patch protocol", () => {
  it("lints every changed application TypeScript file in its workspace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-lint-hook-"));
    tempDirs.push(dir);
    const log = path.join(dir, "pnpm.log");
    const pnpm = path.join(dir, "pnpm");
    writeFileSync(pnpm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$MOCK_PNPM_LOG"\n`);
    chmodSync(pnpm, 0o755);

    const patch = `*** Begin Patch
*** Update File: apps/main/src/proxy.ts
@@
-old
+new
*** Update File: apps/rag/src/app/api/ingest/route.ts
@@
-old
+new
*** Update File: docs/runbooks/pr-workflow.md
@@
-old
+new
*** End Patch`;
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ cwd: REPO_ROOT, tool_name: "apply_patch", tool_input: { command: patch } }),
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, MOCK_PNPM_LOG: log },
    });
    const calls = readFileSync(log, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain("--filter @atc/main exec eslint");
    expect(calls).toContain(path.join(REPO_ROOT, "apps/main/src/proxy.ts"));
    expect(calls).toContain("--filter @atc/rag exec eslint");
    expect(calls).toContain(path.join(REPO_ROOT, "apps/rag/src/app/api/ingest/route.ts"));
    expect(calls).not.toContain("docs/runbooks/pr-workflow.md");
  });

  it("fails loud when the Codex patch payload is malformed", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ cwd: REPO_ROOT, tool_name: "apply_patch", tool_input: {} }),
      encoding: "utf8",
      cwd: REPO_ROOT,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Could not parse edited paths");
  });

  it("fails loud when lint cannot start", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codex-lint-hook-"));
    tempDirs.push(dir);
    const patch = `*** Begin Patch
*** Update File: apps/main/src/proxy.ts
@@
-old
+new
*** End Patch`;
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify({ cwd: REPO_ROOT, tool_name: "apply_patch", tool_input: { command: patch } }),
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: dir },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Lint could not run for @atc/main");
  });

  it("fails loud when the hook input is not JSON", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "not-json",
      encoding: "utf8",
      cwd: REPO_ROOT,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Could not parse hook input");
  });
});
