import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findActionRuntimeErrors } from "../../../scripts/check-action-runtimes.mjs";

describe("workflow action runtime guard", () => {
  it("accepts the maintained action majors in repository workflows", () => {
    expect(findActionRuntimeErrors()).toEqual([]);
  });

  it("rejects each obsolete Node 20 action major", () => {
    const directory = mkdtempSync(join(tmpdir(), "atc-action-runtime-"));
    writeFileSync(join(directory, "workflow.yml"), `steps:
  - uses: actions/cache@v4
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
  - uses: actions/upload-artifact@v4
  - uses: dependabot/fetch-metadata@v2
  - uses: gitleaks/gitleaks-action@v2
  - uses: github/codeql-action/analyze@v3
  - uses: github/codeql-action/init@v3
  - uses: pnpm/action-setup@v4
`);

    try {
      expect(findActionRuntimeErrors(directory)).toEqual([
        "workflow.yml:2: actions/cache@v4 must use actions/cache@v6.",
        "workflow.yml:3: actions/checkout@v4 must use actions/checkout@v7.",
        "workflow.yml:4: actions/setup-node@v4 must use actions/setup-node@v7.",
        "workflow.yml:5: actions/upload-artifact@v4 must use actions/upload-artifact@v7.",
        "workflow.yml:6: dependabot/fetch-metadata@v2 must use dependabot/fetch-metadata@v3.",
        "workflow.yml:7: gitleaks/gitleaks-action@v2 must use gitleaks/gitleaks-action@v3.",
        "workflow.yml:8: github/codeql-action/analyze@v3 must use github/codeql-action/analyze@v4.",
        "workflow.yml:9: github/codeql-action/init@v3 must use github/codeql-action/init@v4.",
        "workflow.yml:10: pnpm/action-setup@v4 must use pnpm/action-setup@v6.",
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
