#!/usr/bin/env tsx

// Local-only adapter from ATC's append-only decision log to Funes 1.3.0.
//
// The source corpus is deliberately synthetic Codex JSONL: Funes already has
// a stable parser for that shape, so this adapter owns only ATC's decision-log
// grammar and the append-only export boundary. It never installs/configures
// Funes and exposes no Hub, add, push, ask, or MCP path.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FUNES_VERSION = "1.3.0";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const STATE_DIRECTORY = ".funes-atc";
const SOURCE_DIRECTORY = "source";
const DECISION_HEADER_RE = /^## (D-\d+[a-z]?) — (\d{4}-\d{2}-\d{2}) —/gm;
const REBUILD_INSTRUCTION =
  "Rebuild explicitly by moving or removing .funes-atc, then rerun `pnpm exec tsx scripts/funes-memory.ts export`.";
const SENSITIVE_CHILD_ENV = [
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HUGGINGFACE_TOKEN",
  "FUNES_MEMORY",
  "HF_TOKEN_PATH",
  "HF_ENDPOINT",
] as const;

export interface DecisionEntry {
  id: string;
  date: string;
  text: string;
}

export interface ExportResult {
  sourceDir: string;
  created: string[];
  unchanged: string[];
}

export interface ChildInvocation {
  command: "funes";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type ChildRunner = (invocation: ChildInvocation) => ChildResult;

export interface RuntimeOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  run?: ChildRunner;
}

const asciiSort = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(asciiSort);
}

/** Parse exact ATC headers and retain each complete entry through the next decision header. */
export function parseDecisionLog(text: string): DecisionEntry[] {
  const lines = text.split(/\n/);
  const exactLine = /^## (D-\d+[a-z]?) — (\d{4}-\d{2}-\d{2}) —/;
  const malformed = lines.filter(
    (line) => /^## D-/.test(line) && !exactLine.test(line.replace(/\r$/, "")),
  );
  if (malformed.length > 0) {
    throw new Error(
      `Malformed decision header(s): ${malformed.map((line) => line.replace(/\r$/, "")).join(" | ")}`,
    );
  }

  const matches = [...text.matchAll(DECISION_HEADER_RE)];
  if (matches.length === 0)
    throw new Error("MEMORY.md contains no exact ATC decision headers");

  const ids = matches.map((match) => match[1]!);
  const duplicates = duplicateValues(ids);
  if (duplicates.length > 0)
    throw new Error(
      `Duplicate decision ID(s) in MEMORY.md: ${duplicates.join(", ")}`,
    );

  return matches.map((match, index) => {
    const start = match.index!;
    const end = matches[index + 1]?.index ?? text.length;
    return {
      id: match[1]!,
      date: match[2]!,
      text: text.slice(start, end).trim(),
    };
  });
}

/** Extract the exact `- D-NNN[x] — YYYY-MM-DD — ...` rows from one index. */
export function parseIndex(text: string, label: string): string[] {
  const lines = text.split(/\n/);
  const exactLine = /^- (D-\d+[a-z]?) — \d{4}-\d{2}-\d{2} —/;
  const malformed = lines.filter(
    (line) => /^- D-/.test(line) && !exactLine.test(line.replace(/\r$/, "")),
  );
  if (malformed.length > 0) {
    throw new Error(
      `Malformed decision index row(s) in ${label}: ${malformed.map((line) => line.replace(/\r$/, "")).join(" | ")}`,
    );
  }

  const ids = lines
    .map((line) => exactLine.exec(line.replace(/\r$/, ""))?.[1])
    .filter((id): id is string => id !== undefined);
  const duplicates = duplicateValues(ids);
  if (duplicates.length > 0)
    throw new Error(
      `Duplicate decision ID(s) in ${label}: ${duplicates.join(", ")}`,
    );
  return ids;
}

/** Enforce the lean/archive partition as an exact, disjoint cover of MEMORY.md. */
export function validateDecisionIndexes(
  memoryIds: string[],
  leanIds: string[],
  archiveIds: string[],
): void {
  const duplicateMemory = duplicateValues(memoryIds);
  const duplicateLean = duplicateValues(leanIds);
  const duplicateArchive = duplicateValues(archiveIds);
  if (duplicateMemory.length > 0)
    throw new Error(
      `Duplicate decision ID(s) in MEMORY.md: ${duplicateMemory.join(", ")}`,
    );
  if (duplicateLean.length > 0)
    throw new Error(
      `Duplicate decision ID(s) in MEMORY-INDEX.md: ${duplicateLean.join(", ")}`,
    );
  if (duplicateArchive.length > 0) {
    throw new Error(
      `Duplicate decision ID(s) in MEMORY-INDEX-ARCHIVE.md: ${duplicateArchive.join(", ")}`,
    );
  }

  const memory = new Set(memoryIds);
  const lean = new Set(leanIds);
  const archive = new Set(archiveIds);
  const overlap = [...lean].filter((id) => archive.has(id)).sort(asciiSort);
  if (overlap.length > 0) {
    throw new Error(
      `Decision ID(s) appear in both lean and archive indexes: ${overlap.join(", ")}`,
    );
  }

  const union = new Set([...lean, ...archive]);
  const missing = [...memory].filter((id) => !union.has(id)).sort(asciiSort);
  const extra = [...union].filter((id) => !memory.has(id)).sort(asciiSort);
  if (missing.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0)
      details.push(`missing from both indexes: ${missing.join(", ")}`);
    if (extra.length > 0)
      details.push(
        `listed in an index but not in MEMORY.md: ${extra.join(", ")}`,
      );
    throw new Error(`Decision index coverage mismatch: ${details.join("; ")}`);
  }
}

/** Render the minimal modern Codex envelope shape consumed by Funes 1.3.0. */
export function renderDecisionJsonl(entry: DecisionEntry): string {
  const timestamp = `${entry.date}T00:00:00.000Z`;
  const sessionId = `atc-memory-${entry.id}`;
  const sessionMeta = {
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp,
      cwd: "/ai-travel-concierge",
    },
  };
  const message = {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: entry.text }],
    },
  };
  return `${JSON.stringify(sessionMeta)}\n${JSON.stringify(message)}\n`;
}

function rejectSymlink(target: string): void {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing symlinked local Funes path ${target}`);
  }
}

/** Validate first, then add only previously absent generated sessions. */
export function exportDecisionMemory(repoRoot = REPO_ROOT): ExportResult {
  const memoryPath = path.join(repoRoot, "MEMORY.md");
  const leanPath = path.join(repoRoot, "MEMORY-INDEX.md");
  const archivePath = path.join(repoRoot, "MEMORY-INDEX-ARCHIVE.md");
  const entries = parseDecisionLog(fs.readFileSync(memoryPath, "utf8"));
  const leanIds = parseIndex(
    fs.readFileSync(leanPath, "utf8"),
    "MEMORY-INDEX.md",
  );
  const archiveIds = parseIndex(
    fs.readFileSync(archivePath, "utf8"),
    "MEMORY-INDEX-ARCHIVE.md",
  );
  validateDecisionIndexes(
    entries.map((entry) => entry.id),
    leanIds,
    archiveIds,
  );

  const stateDir = path.join(repoRoot, STATE_DIRECTORY);
  const sourceDir = path.join(stateDir, SOURCE_DIRECTORY);
  rejectSymlink(stateDir);
  rejectSymlink(sourceDir);

  const expected = new Map(
    entries.map((entry) => [`${entry.id}.jsonl`, renderDecisionJsonl(entry)]),
  );
  if (fs.existsSync(sourceDir) && !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(
      `Refusing export because ${sourceDir} is not a directory. ${REBUILD_INSTRUCTION}`,
    );
  }
  const existing = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir, { withFileTypes: true })
    : [];

  const extras = existing
    .filter((entry) => !entry.isFile() || !expected.has(entry.name))
    .map((entry) => entry.name)
    .sort(asciiSort);
  if (extras.length > 0) {
    throw new Error(
      `Refusing export: removed IDs or unexplained extras remain in .funes-atc/source: ${extras.join(", ")}. ${REBUILD_INSTRUCTION}`,
    );
  }

  const changed: string[] = [];
  for (const entry of existing) {
    const expectedText = expected.get(entry.name)!;
    const actual = fs.readFileSync(path.join(sourceDir, entry.name));
    if (!actual.equals(Buffer.from(expectedText, "utf8")))
      changed.push(entry.name.replace(/\.jsonl$/, ""));
  }
  if (changed.length > 0) {
    throw new Error(
      `Refusing export: changed historical generated files for ${changed.sort(asciiSort).join(", ")}. ${REBUILD_INSTRUCTION}`,
    );
  }

  fs.mkdirSync(sourceDir, { recursive: true });
  const existingNames = new Set(existing.map((entry) => entry.name));
  const created: string[] = [];
  const unchanged: string[] = [];
  for (const entry of entries) {
    const filename = `${entry.id}.jsonl`;
    if (existingNames.has(filename)) {
      unchanged.push(entry.id);
      continue;
    }
    fs.writeFileSync(path.join(sourceDir, filename), expected.get(filename)!, {
      encoding: "utf8",
      flag: "wx",
    });
    created.push(entry.id);
  }
  return { sourceDir, created, unchanged };
}

export function sanitizedChildEnv(
  repoRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of SENSITIVE_CHILD_ENV) delete env[name];
  env.FUNES_HOME = path.join(repoRoot, STATE_DIRECTORY);
  env.HF_HOME = path.join(repoRoot, STATE_DIRECTORY, "hf-home");
  env.HF_HUB_DISABLE_IMPLICIT_TOKEN = "1";
  return env;
}

function runChild(invocation: ChildInvocation): ChildResult {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: invocation.shell,
    encoding: "utf8",
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function invokeFunes(args: string[], options: RuntimeOptions): ChildResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  rejectSymlink(path.join(repoRoot, STATE_DIRECTORY));
  const env = sanitizedChildEnv(repoRoot, options.env ?? process.env);
  fs.mkdirSync(env.HF_HOME!, { recursive: true });
  const result = (options.run ?? runChild)({
    command: "funes",
    args,
    cwd: repoRoot,
    env,
    shell: false,
  });
  if (result.error) {
    throw new Error(
      `Could not run external Funes ${FUNES_VERSION}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `terminated by ${result.signal ?? "unknown signal"}`;
    throw new Error(`Funes command failed (${args.join(" ")}): ${detail}`);
  }
  return result;
}

function detectedFunesVersion(stdout: string): string {
  const output = stdout.trim();
  const standard = /^funes (\S+)$/.exec(output);
  return standard?.[1] ?? output;
}

export function indexDecisionMemory(
  options: RuntimeOptions = {},
): ExportResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const exported = exportDecisionMemory(repoRoot);
  const versionResult = invokeFunes(["--version"], { ...options, repoRoot });
  const actualVersion = detectedFunesVersion(versionResult.stdout);
  if (actualVersion !== FUNES_VERSION) {
    throw new Error(
      `This adapter requires Funes ${FUNES_VERSION}; found ${actualVersion || "no parseable version"}.`,
    );
  }

  const result = invokeFunes(
    [
      "index",
      exported.sourceDir,
      "--harness",
      "codex",
      "--yes",
      "--no-thinking",
    ],
    { ...options, repoRoot },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return exported;
}

export function recallDecisionMemory(
  query: string,
  options: RuntimeOptions = {},
): ChildResult {
  const normalized = query.trim();
  if (normalized.length === 0)
    throw new Error("Recall requires a non-empty query");
  const result = invokeFunes(
    ["recall", "--memory", "local", "--half-life", "0", "--", normalized],
    options,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function usageError(detail?: string): Error {
  const prefix = detail ? `${detail}. ` : "";
  return new Error(
    `${prefix}Usage: funes-memory.ts <export | index | recall QUERY>`,
  );
}

export function runCli(args: string[], options: RuntimeOptions = {}): void {
  const [command, ...rest] = args;
  switch (command) {
    case "export": {
      if (rest.length > 0) throw usageError("export accepts no arguments");
      const result = exportDecisionMemory(options.repoRoot ?? REPO_ROOT);
      console.log(
        `Exported ${result.created.length} new decision(s); preserved ${result.unchanged.length} unchanged decision(s) in ${result.sourceDir}.`,
      );
      return;
    }
    case "index":
      if (rest.length > 0) throw usageError("index accepts no arguments");
      indexDecisionMemory(options);
      return;
    case "recall":
      recallDecisionMemory(rest.join(" "), options);
      return;
    case undefined:
      throw usageError();
    default:
      throw usageError(`Unknown subcommand ${JSON.stringify(command)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `funes-memory: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
