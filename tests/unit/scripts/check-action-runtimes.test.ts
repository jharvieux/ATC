import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findActionRuntimeErrors } from "../../../scripts/check-action-runtimes.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function workflowFixture(contents: string) {
  const directory = mkdtempSync(join(tmpdir(), "atc-action-runtime-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "workflow.yml"), contents);
  return directory;
}

describe("workflow action runtime guard", () => {
  it("accepts the maintained action majors in repository workflows", () => {
    expect(findActionRuntimeErrors()).toEqual([]);
  });

  it("rejects each obsolete Node 20 action major", () => {
    const fixture = workflowFixture(`steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
  - uses: gitleaks/gitleaks-action@v2
  - uses: pnpm/action-setup@v4
`);

    expect(findActionRuntimeErrors(fixture)).toEqual([
      "workflow.yml:2: actions/checkout@v4 must use actions/checkout@v7.",
      "workflow.yml:3: actions/setup-node@v4 must use actions/setup-node@v7.",
      "workflow.yml:4: gitleaks/gitleaks-action@v2 must use gitleaks/gitleaks-action@v3.",
      "workflow.yml:5: pnpm/action-setup@v4 must use pnpm/action-setup@v6.",
    ]);
  });
});
