import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getNodeRuntimeError } from "../../../scripts/check-node-runtime.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const node26Preload = fileURLToPath(new URL("../../fixtures/node-26-runtime.cjs", import.meta.url));

function runPnpmAsNode26(args: string[]) {
  return spawnSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${node26Preload}`,
    },
    timeout: 10_000,
  });
}

describe("getNodeRuntimeError", () => {
  it("accepts supported Node 24 patch releases", () => {
    expect(getNodeRuntimeError("v24.19.0", "/node24/bin/node")).toBeNull();
    expect(getNodeRuntimeError("24.15.0", "/node24/bin/node")).toBeNull();
  });

  it("rejects Node 26 with an actionable runtime error", () => {
    expect(getNodeRuntimeError("v26.0.0", "/opt/homebrew/bin/node")).toBe(
      "Node.js 24.x is required; found v26.0.0.\n" +
        "Runtime: /opt/homebrew/bin/node\n" +
        "Run `nvm use` from the repository root and retry.",
    );
  });

  it("fails closed when the runtime version is malformed", () => {
    for (const version of ["unknown", "v24garbage", "24beta", "v24.19x", "v24.19.0-rc.1"]) {
      expect(getNodeRuntimeError(version, "/unexpected/node"), version).toContain(
        "Node.js 24.x is required",
      );
    }
  });

  it("blocks secondary scripts and dependency operations before work under Node 26", () => {
    for (const args of [
      ["run", "lint:migrations", "--help"],
      ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"],
      ["add", "--help"],
    ]) {
      const result = runPnpmAsNode26(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(`${result.stdout}${result.stderr}`, args.join(" ")).toContain(
        "Node.js 24.x is required; found v26.0.0.",
      );
    }
  });
});
