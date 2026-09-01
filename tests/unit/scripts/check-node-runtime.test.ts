import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getNodeRuntimeError } from "../../../scripts/check-node-runtime.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  devEngines: { runtime: { name: string; version: string; onFail: string } };
  scripts: Record<string, string>;
};

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
    expect(getNodeRuntimeError("unknown", "/unexpected/node")).toContain("Node.js 24.x is required");
  });

  it("guards every primary repository workflow before work begins", () => {
    expect(packageJson.devEngines.runtime).toEqual({
      name: "node",
      version: "24.x",
      onFail: "error",
    });

    for (const script of [
      "dev",
      "build",
      "lint",
      "typecheck",
      "test",
      "test:watch",
      "verify",
      "verify:fast",
    ]) {
      expect(packageJson.scripts[script], script).toMatch(/^pnpm check:node-runtime && /);
    }
  });
});
