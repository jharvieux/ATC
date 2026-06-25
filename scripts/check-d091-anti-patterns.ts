// #815 — Mechanical CI gates for the recurring D-091 anti-patterns.
//
// The D-091 rules are prose in CLAUDE.md + checked by the probabilistic
// d091-reviewer subagent (it has missed real cases — #805, #808). Several
// anti-patterns recur AND are mechanically detectable; these deterministic
// grep-style gates are the backstop. Mirrors the check:dropped-columns /
// check:page-service-role pattern: fail the build, with an inline escape hatch.
//
// ESCAPE HATCH: put `d091-allow:<id>` (optionally `<id> <reason>`) on the
// offending line or the line directly above it. Use a real reason.
//
// Detectors (id):
//   secret-eq           (3) — ===/!== on a secret/token/key/hmac/signature var
//   cas-rowcount        (2) — .update().eq("status",…) CAS without a row-count check
//   counter-rmw         (6) — .update({ <counter/balance/quota>: <var> ± … }) — a
//                             non-atomic read-modify-write; concurrent requests
//                             double-spend. Use a DB-side atomic increment (RPC /
//                             SQL expression) or a CAS reserve-row. (#1393/G3;
//                             Day-1 F-pay-01 / F-sm-01 / F-sm-02.)
//   unbounded-limit     (4) — .limit(n) with n > 1000 (PostgREST cap; paginate)
//   event-data-cast     (5) — Inngest `event.data as` without a Zod parse
//   service-role-tenant (1) — service-role .from(tenant-table) filtered but
//                             missing .eq("tenant_id",…). Baseline-allowlisted
//                             (scripts/d091-baseline.txt) because
//                             the existing debt is tracked in the security
//                             backlog (#726/#730/#740/#743/#748/#752); the gate
//                             fails on NEW occurrences only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["apps/main/src", "apps/rag/src"];
const BASELINE_FILE = path.join(ROOT, "scripts/d091-baseline.txt");

interface Violation {
  id: string;
  file: string; // repo-relative
  line: number; // 1-indexed
  snippet: string;
  why: string;
}

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(rel));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !rel.includes("/test/") && !rel.includes("/__tests__/")) {
      out.push(rel);
    }
  }
  return out;
}

// A hit is allowed if the line OR the preceding non-blank line carries
// `d091-allow:<id>` (or `d091-allow:all`).
function isInlineAllowed(lines: string[], idx: number, id: string): boolean {
  const tokens = [`d091-allow:${id}`, "d091-allow:all"];
  const here = lines[idx] ?? "";
  if (tokens.some((t) => here.includes(t))) return true;
  for (let j = idx - 1; j >= 0; j -= 1) {
    const prev = lines[j] ?? "";
    if (prev.trim() === "") continue;
    return tokens.some((t) => prev.includes(t));
  }
  return false;
}

// Platform-scoped tables (no tenant_id, or service-role-by-design) — a
// service-role query on these legitimately has no tenant_id filter. Seeded from
// db/rls-exceptions.txt (its first token per non-comment line) + a few extras.
function platformTables(): Set<string> {
  const set = new Set<string>([
    "schema_migrations", "tenants", "tenant_registry_shadow", "platform_settings",
    "knowledge_chunks", "knowledge_ingestion_queue", "rag_retrieval_log",
    "knowledge_chunk_feedback_events", "itineraries", "general_pricing_ranges",
    "rag_media_assets", "ai_pricing_catalog", "platform_admin_audit_log",
  ]);
  const ex = path.join(ROOT, "db/rls-exceptions.txt");
  if (fs.existsSync(ex)) {
    for (const raw of fs.readFileSync(ex, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const name = line.split(/[\s#]/)[0];
      if (name) set.add(name);
    }
  }
  return set;
}
const PLATFORM_TABLES = platformTables();

// --- Detector (3): ===/!== on a secret-shaped variable ---------------------
export function detectSecretEq(file: string, lines: string[]): Violation[] {
  const out: Violation[] = [];
  // An operand whose identifier ends in secret/token/hmac/signature/apiKey/api_key,
  // on EITHER side of the comparison (`token === x` or `x === token`).
  const name = "[A-Za-z0-9_.]*(?:secret|token|hmac|signature|apikey|api_key)";
  const left = new RegExp(`\\b(${name})\\s*(===|!==)`, "i");
  const right = new RegExp(`(===|!==)\\s*(${name})\\b`, "i");
  lines.forEach((ln, i) => {
    const lm = left.exec(ln);
    const rm = right.exec(ln);
    if (!lm && !rm) return;
    // Skip non-secret comparisons: existence checks and `typeof x === "string"`
    // primitive-type guards (the operand isn't a secret value being matched).
    if (/(===|!==)\s*(null|undefined)\b/.test(ln)) return;
    if (/\btypeof\b/.test(ln)) return;
    if (/(===|!==)\s*["'](string|number|boolean|object|undefined|function|symbol|bigint)["']/.test(ln)) return;
    if (isInlineAllowed(lines, i, "secret-eq")) return;
    const varName = lm ? lm[1] : rm![2];
    const op = lm ? lm[2] : rm![1];
    out.push({ id: "secret-eq", file, line: i + 1, snippet: ln.trim(), why: `'${varName}' compared with ${op} — use timingSafeEqual/constantTimeEqual for secrets` });
  });
  return out;
}

// --- Detector (4): .limit(n) with n > 1000 ---------------------------------
export function detectUnboundedLimit(file: string, lines: string[]): Violation[] {
  const out: Violation[] = [];
  const re = /\.limit\(\s*(\d{3,})\s*\)/g;
  lines.forEach((ln, i) => {
    for (const m of ln.matchAll(re)) {
      if (Number(m[1]) <= 1000) continue;
      if (isInlineAllowed(lines, i, "unbounded-limit")) continue;
      out.push({ id: "unbounded-limit", file, line: i + 1, snippet: ln.trim(), why: `.limit(${m[1]}) exceeds the 1000-row PostgREST cap — paginate with .range()` });
    }
  });
  return out;
}

// --- Detector (5): Inngest `event.data as` without a nearby Zod parse -------
export function detectEventDataCast(file: string, lines: string[]): Violation[] {
  if (!file.includes("/inngest/")) return [];
  const out: Violation[] = [];
  const text = lines.join("\n");
  // Only a parse OF event.data validates it — a `.parse()` on unrelated data
  // (e.g. an LLM response) elsewhere in the file must NOT suppress the cast.
  const usesZodOnData = /\b(?:parse|safeParse)\(\s*event\.data\b/.test(text);
  lines.forEach((ln, i) => {
    if (!/event\.data\s+as\s+/.test(ln)) return;
    if (isInlineAllowed(lines, i, "event-data-cast")) return;
    if (usesZodOnData) return;
    out.push({ id: "event-data-cast", file, line: i + 1, snippet: ln.trim(), why: "Inngest `event.data as` cast without a Zod parse — validate before use" });
  });
  return out;
}

// --- Detector (2): CAS .update().eq("status",…) without a row-count check ---
export function detectCasRowcount(file: string, lines: string[]): Violation[] {
  const out: Violation[] = [];
  lines.forEach((ln, i) => {
    if (!/\.update\(/.test(ln)) return;
    // Gather the statement (this line + following lines until ';' or blank).
    const chunk: string[] = [];
    for (let j = i; j < lines.length && j < i + 12; j += 1) {
      chunk.push(lines[j] ?? "");
      if ((lines[j] ?? "").includes(";")) break;
      if (j > i && (lines[j] ?? "").trim() === "") break;
    }
    const stmt = chunk.join("\n");
    const isStatusCas = /\.eq\(\s*['"`](status|state)['"`]/.test(stmt);
    if (!isStatusCas) return;
    // OK if it verifies the affected row count.
    if (/safeAwaitRowCount|\.select\(/.test(stmt)) return;
    if (isInlineAllowed(lines, i, "cas-rowcount")) return;
    out.push({ id: "cas-rowcount", file, line: i + 1, snippet: ln.trim(), why: "status-guarded .update() (CAS) without safeAwaitRowCount/.select() row-count check — a zero-row no-op is silent" });
  });
  return out;
}

// --- Detector (6): non-atomic read-modify-write on a counter/financial field ---
// The dangerous form is `.update({ messages_used: usage + 1 })` /
// `.update({ balance: current - amount })`: the new value is computed in app code
// from a previously-read row value, so two concurrent requests both read the old
// value and the second write clobbers the first → quota/limit overrun or money
// double-counted (Day-1 F-pay-01, F-sm-01, F-sm-02). The fix is a DB-side atomic
// increment (an RPC running `col = col + n` in SQL) or a CAS reserve-row.
//
// Heuristic: inside a `.update({…})` payload, a key whose name contains a
// counter/quota/financial token, assigned to an expression that begins with an
// identifier and applies `+`/`-`. The leading-identifier requirement keeps
// absolute/literal assignments out (`amount: -500`, `count: 0`, `balance: row`),
// firing only on the read-modify-write shape (`x + 1`, `row.count - n`). Derived
// absolute computations on the same fields (`total: subtotal + tax`) are the
// known false-positive class — suppress those with `d091-allow:counter-rmw <why>`.
const COUNTER_KEY =
  "[a-z_]*(?:count|used|usage|remaining|balance|attempts|quota|credits|tokens|spend|spent)[a-z_]*";
const COUNTER_RMW_RE = new RegExp(
  `\\b${COUNTER_KEY}\\s*:\\s*[A-Za-z_$][\\w.$]*\\s*[+\\-]`,
  "i",
);
export function detectCounterRmw(file: string, lines: string[]): Violation[] {
  const out: Violation[] = [];
  lines.forEach((ln, i) => {
    if (!/\.update\(/.test(ln)) return;
    const chunk: string[] = [];
    for (let j = i; j < lines.length && j < i + 12; j += 1) {
      chunk.push(lines[j] ?? "");
      if ((lines[j] ?? "").includes(";")) break;
      if (j > i && (lines[j] ?? "").trim() === "") break;
    }
    const stmt = chunk.join("\n");
    if (!COUNTER_RMW_RE.test(stmt)) return;
    if (isInlineAllowed(lines, i, "counter-rmw")) return;
    out.push({
      id: "counter-rmw",
      file,
      line: i + 1,
      snippet: ln.trim(),
      why: "non-atomic read-modify-write on a counter/financial field — concurrent requests double-spend; use a DB-side atomic increment (RPC / SQL expression) or a CAS reserve-row",
    });
  });
  return out;
}

// --- Detector (1): service-role .from(tenant-table) missing tenant_id ------
export function detectServiceRoleTenant(file: string, lines: string[]): Violation[] {
  const text = lines.join("\n");
  // Also gate-in modules that RECEIVE a client as a `SupabaseClient`-typed
  // parameter without naming the factory — the caller may hand them the
  // service-role client (#1023; how run-generation-loop.ts escaped the scan).
  // Conservative on purpose: an RLS-backed client passed the same way gets
  // flagged too — suppress with `d091-allow:service-role-tenant <reason>`.
  if (!/createServiceRoleClient|SUPABASE_SERVICE_ROLE_KEY|serviceRoleClient|:\s*SupabaseClient\b/.test(text)) return [];
  const out: Violation[] = [];
  const fromRe = /\.from\(\s*['"`]([a-z0-9_]+)['"`]\s*\)/i;
  lines.forEach((ln, i) => {
    const m = fromRe.exec(ln);
    if (!m) return;
    const table = m[1]!;
    if (PLATFORM_TABLES.has(table)) return;
    const chunk: string[] = [];
    for (let j = i; j < lines.length && j < i + 12; j += 1) {
      chunk.push(lines[j] ?? "");
      if ((lines[j] ?? "").includes(";")) break;
      if (j > i && (lines[j] ?? "").trim() === "") break;
    }
    const stmt = chunk.join("\n");
    // Only a real filtered query (has .eq/.in) — full-table platform reads are
    // out of scope here (covered by other gates). The bug pattern is a query
    // filtered by some id but NOT tenant-scoped.
    if (!/\.(eq|in|match)\(/.test(stmt)) return;
    if (/tenant_id/.test(stmt)) return;
    if (isInlineAllowed(lines, i, "service-role-tenant")) return;
    out.push({ id: "service-role-tenant", file, line: i + 1, snippet: ln.trim(), why: `service-role .from("${table}") filtered without .eq("tenant_id",…) — cross-tenant read/write risk` });
  });
  return out;
}

function violationKey(v: Violation): string {
  return `${v.file}\t${v.id}\t${v.snippet}`;
}

// Baseline maps a violation key (file+id+snippet) → the COUNT of accepted
// (existing) occurrences. Line format: <count>\t<file>\t<id>\t<snippet>. Storing
// the count (not just presence) is what lets the gate catch a NEW duplicate of
// an already-baselined line.
function loadBaseline(): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(BASELINE_FILE)) return map;
  for (const raw of fs.readFileSync(BASELINE_FILE, "utf8").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const count = Number(parts[0]);
    const key = parts.slice(1).join("\t"); // file\tid\tsnippet
    if (Number.isFinite(count)) map.set(key, count);
  }
  return map;
}

// Group hits by key and return those in EXCESS of the baselined count — the
// genuinely NEW occurrences (a new duplicate of a baselined line counts).
export function computeNewViolations(all: Violation[], baseline: Map<string, number>): Violation[] {
  const byKey = new Map<string, Violation[]>();
  for (const v of all) {
    const k = violationKey(v);
    const list = byKey.get(k) ?? [];
    list.push(v);
    byKey.set(k, list);
  }
  const out: Violation[] = [];
  for (const [key, vs] of byKey) {
    const allowed = baseline.get(key) ?? 0;
    if (vs.length > allowed) out.push(...vs.slice(allowed));
  }
  return out;
}

function main(): void {
  const files = SCAN_DIRS.flatMap(walk);
  const all: Violation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
    all.push(...detectSecretEq(file, lines));
    all.push(...detectUnboundedLimit(file, lines));
    all.push(...detectEventDataCast(file, lines));
    all.push(...detectCasRowcount(file, lines));
    all.push(...detectCounterRmw(file, lines));
    all.push(...detectServiceRoleTenant(file, lines));
  }

  // `--update-baseline` snapshots the CURRENT hits so the gate fails only on NEW
  // ones. Run it deliberately when intentionally accepting/triaging debt; never
  // as a reflex to silence a fresh violation (fix it or add an inline
  // `d091-allow:<id> <reason>` instead).
  if (process.argv.includes("--update-baseline")) {
    const counts = new Map<string, number>();
    for (const v of all) counts.set(violationKey(v), (counts.get(violationKey(v)) ?? 0) + 1);
    const header =
      "# d091 anti-pattern baseline — existing hits accepted as tracked debt.\n" +
      "# Regenerate: pnpm check:d091 --update-baseline. The gate fails on NEW hits\n" +
      "# only — including a NEW occurrence beyond the recorded count for a line.\n" +
      "# Line format: <count>\\t<file>\\t<id>\\t<snippet>. Prefer fixing or an inline\n" +
      "# `d091-allow:<id> <reason>` over growing this.\n";
    const body = [...counts.entries()].map(([k, c]) => `${c}\t${k}`).sort().join("\n");
    fs.writeFileSync(BASELINE_FILE, `${header}${body}\n`);
    console.log(`Wrote ${counts.size} baseline entr(ies) (${all.length} occurrences) to ${path.relative(ROOT, BASELINE_FILE)}.`);
    return;
  }

  // The existing debt is snapshotted in the baseline (the real bugs are tracked
  // in the security backlog), so the gate fails only on NEW occurrences — count-
  // aware, so a new duplicate of a baselined line is still caught.
  const failures = computeNewViolations(all, loadBaseline());

  if (failures.length === 0) {
    console.log(`✔ d091-anti-patterns: ${files.length} files scanned, 0 new violations (${all.length} baselined).`);
    return;
  }

  console.error(`✖ d091-anti-patterns: ${failures.length} violation(s):\n`);
  for (const v of failures) {
    console.error(`  [${v.id}] ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
    console.error(`    → ${v.why}`);
    console.error(`    fix or add \`d091-allow:${v.id} <reason>\` on/above the line.\n`);
  }
  process.exit(1);
}

// Only scan the repo when run directly (`tsx scripts/check-d091-anti-patterns.ts`);
// importing the module for unit tests must NOT trigger the full-repo walk/exit.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
