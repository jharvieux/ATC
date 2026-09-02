#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_ACTION_MAJORS = Object.freeze({
  "actions/cache": "v6",
  "actions/checkout": "v7",
  "actions/setup-node": "v7",
  "actions/upload-artifact": "v7",
  "dependabot/fetch-metadata": "v3",
  "gitleaks/gitleaks-action": "v3",
  "github/codeql-action/analyze": "v4",
  "github/codeql-action/init": "v4",
  "pnpm/action-setup": "v6",
});

const workflowDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/workflows");

function workflowFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return workflowFiles(path);
    return [".yml", ".yaml"].includes(extname(entry.name)) ? [path] : [];
  });
}

export function findActionRuntimeErrors(root = workflowDirectory) {
  const actionPattern = Object.keys(REQUIRED_ACTION_MAJORS).join("|");
  const usesPattern = new RegExp(
    `^\\s*(?:-\\s+)?uses:\\s*(${actionPattern})@([^\\s#]+)`,
    "gm",
  );

  return workflowFiles(root).flatMap((file) => {
    const workflow = readFileSync(file, "utf8");
    const errors = [];
    for (const match of workflow.matchAll(usesPattern)) {
      const [, action, version] = match;
      const expectedVersion = REQUIRED_ACTION_MAJORS[action];
      if (version === expectedVersion) continue;

      const line = workflow.slice(0, match.index).split("\n").length;
      errors.push(
        `${relative(root, file)}:${line}: ${action}@${version} must use ${action}@${expectedVersion}.`,
      );
    }
    return errors;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = findActionRuntimeErrors();
  if (errors.length > 0) {
    console.error(["Workflow action runtime guard failed:", ...errors].join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Workflow action runtime guard passed.");
  }
}
