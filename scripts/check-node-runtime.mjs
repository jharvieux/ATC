#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const REQUIRED_NODE_MAJOR = 24;

export function getNodeRuntimeError(version, execPath) {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (major === REQUIRED_NODE_MAJOR) return null;

  return [
    `Node.js ${REQUIRED_NODE_MAJOR}.x is required; found ${version}.`,
    `Runtime: ${execPath}`,
    "Run `nvm use` from the repository root and retry.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const error = getNodeRuntimeError(process.version, process.execPath);
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Node.js ${process.versions.node} satisfies the required 24.x runtime.`);
  }
}
