#!/usr/bin/env tsx

// Local-only adapter from ATC's append-only decision log to Funes 1.3.0.
//
// The source corpus is deliberately synthetic Codex JSONL: Funes already has
// a stable parser for that shape, so this adapter owns only ATC's decision-log
// grammar and the append-only export boundary. It never installs/configures
// Funes and exposes no Hub, add, push, ask, or MCP path.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FUNES_VERSION = "1.3.0";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const STATE_DIRECTORY = ".funes-atc";
const SOURCE_DIRECTORY = "source";
const MANIFEST_FILENAME = "export-manifest.json";
const MANIFEST_VERSION = 1;
const DECISION_HEADER_RE = /^## (D-\d+[a-z]?) — (\d{4}-\d{2}-\d{2}) —/gm;
const REBUILD_INSTRUCTION =
  "Rebuild explicitly by moving or removing .funes-atc, then rerun `pnpm exec tsx scripts/funes-memory.ts export`.";
const RECALL_VERIFICATION_INSTRUCTION =
  "Funes recall is navigation only; verify every hit against authoritative MEMORY.md before relying on it.";

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

interface ExportManifest {
  version: typeof MANIFEST_VERSION;
  entries: Record<string, string>;
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

function validateStateSymlinks(root: string): void {
  if (!fs.existsSync(root)) return;
  const realRoot = fs.realpathSync(root);
  const pending = [root];
  while (pending.length > 0) {
    const target = pending.pop();
    if (target === undefined) break;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(target);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Refusing unresolved local Funes symlink ${target}: ${detail}`);
      }
      const fromRoot = path.relative(realRoot, realTarget);
      const contained =
        fromRoot === "" ||
        (!path.isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${path.sep}`));
      if (!contained) throw new Error(`Refusing local Funes symlink that escapes state: ${target}`);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(target)) pending.push(path.join(target, name));
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function readManifest(manifestPath: string): ExportManifest | undefined {
  rejectSymlink(manifestPath);
  if (!fs.existsSync(manifestPath)) return undefined;
  if (!fs.statSync(manifestPath).isFile()) {
    throw new Error(
      `Refusing export because ${manifestPath} is not a file. ${REBUILD_INSTRUCTION}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing invalid Funes export manifest: ${error instanceof Error ? error.message : String(error)}. ${REBUILD_INSTRUCTION}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== MANIFEST_VERSION ||
    typeof (parsed as { entries?: unknown }).entries !== "object" ||
    (parsed as { entries?: unknown }).entries === null ||
    Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error(
      `Refusing invalid Funes export manifest schema. ${REBUILD_INSTRUCTION}`,
    );
  }

  const entries = (parsed as { entries: Record<string, unknown> }).entries;
  for (const [name, hash] of Object.entries(entries)) {
    if (!/^D-\d+[a-z]?\.jsonl$/.test(name) || !/^[0-9a-f]{64}$/.test(String(hash))) {
      throw new Error(
        `Refusing invalid Funes export manifest entry ${JSON.stringify(name)}. ${REBUILD_INSTRUCTION}`,
      );
    }
  }
  return parsed as ExportManifest;
}

function writeManifest(manifestPath: string, manifest: ExportManifest): void {
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  rejectSymlink(temporaryPath);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporaryPath, manifestPath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
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
  const manifestPath = path.join(stateDir, MANIFEST_FILENAME);
  const stateExisted = fs.existsSync(stateDir);
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

  const manifest = readManifest(manifestPath);
  if (!manifest && stateExisted) {
    throw new Error(
      `Refusing pre-existing local Funes state without its export manifest. ${REBUILD_INSTRUCTION}`,
    );
  }
  const historical = manifest?.entries ?? {};

  const extras = existing
    .filter((entry) => !entry.isFile() || !(entry.name in historical))
    .map((entry) => entry.name)
    .sort(asciiSort);
  if (extras.length > 0) {
    throw new Error(
      `Refusing export: removed IDs or unexplained extras remain in .funes-atc/source: ${extras.join(", ")}. ${REBUILD_INSTRUCTION}`,
    );
  }

  const missingHistorical = Object.keys(historical)
    .filter((name) => !existing.some((entry) => entry.name === name))
    .sort(asciiSort);
  if (missingHistorical.length > 0) {
    throw new Error(
      `Refusing export: historical generated files are missing: ${missingHistorical.join(", ")}. ${REBUILD_INSTRUCTION}`,
    );
  }

  const removed = Object.keys(historical)
    .filter((name) => !expected.has(name))
    .sort(asciiSort);
  const mutated = Object.entries(historical)
    .filter(([name, hash]) => {
      const expectedText = expected.get(name);
      return expectedText !== undefined && digest(expectedText) !== hash;
    })
    .map(([name]) => name.replace(/\.jsonl$/, ""))
    .sort(asciiSort);
  if (removed.length > 0 || mutated.length > 0) {
    const details: string[] = [];
    if (removed.length > 0) details.push(`removed IDs: ${removed.join(", ")}`);
    if (mutated.length > 0)
      details.push(`changed historical decisions: ${mutated.join(", ")}`);
    throw new Error(`Refusing export: ${details.join("; ")}. ${REBUILD_INSTRUCTION}`);
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

  const nextManifest: ExportManifest = {
    version: MANIFEST_VERSION,
    entries: Object.fromEntries(
      entries.map((entry) => {
        const filename = `${entry.id}.jsonl`;
        return [filename, digest(expected.get(filename)!)];
      }),
    ),
  };
  if (!manifest || created.length > 0) writeManifest(manifestPath, nextManifest);
  return { sourceDir, created, unchanged };
}

export function sanitizedChildEnv(
  repoRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("FUNES_") ||
      name.startsWith("HF_") ||
      name.startsWith("HUGGINGFACE_") ||
      name.startsWith("HUGGING_FACE_")
    ) {
      delete env[name];
    }
  }
  env.FUNES_HOME = path.join(repoRoot, STATE_DIRECTORY);
  env.HF_HOME = path.join(repoRoot, STATE_DIRECTORY, "hf-home");
  env.HF_HUB_CACHE = path.join(env.HF_HOME, "hub");
  env.HUGGINGFACE_HUB_CACHE = env.HF_HUB_CACHE;
  env.HF_XET_CACHE = path.join(env.HF_HOME, "xet");
  env.HF_ASSETS_CACHE = path.join(env.HF_HOME, "assets");
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
  const stateDir = path.join(repoRoot, STATE_DIRECTORY);
  validateStateSymlinks(stateDir);
  const env = sanitizedChildEnv(repoRoot, options.env ?? process.env);
  fs.mkdirSync(env.HF_HOME!, { recursive: true });
  validateStateSymlinks(stateDir);
  const result = (options.run ?? runChild)({
    command: "funes",
    args,
    cwd: repoRoot,
    env,
    shell: false,
  });
  validateStateSymlinks(stateDir);
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
      console.error(RECALL_VERIFICATION_INSTRUCTION);
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
