// RLS policy-semantics guard — Harvey Tier-1 port (refs #2006, #2000-series audit).
//
// Ported from Harvey src/scan/supabase-static.ts + src/rls-policy-review.ts +
// src/migration-sql-parse.ts + src/definer-review.ts @ 5b5aada, adapted for ATC
// (no Finding[] plumbing — repo check-script output/exit-code conventions).
//
// Three sub-checks over committed migration SQL (apps/*/supabase/migrations/*.sql),
// static only — never touches a live DB:
//
//   policy-semantics — a `create policy` whose clauses are semantically suspect
//     under the table's inferred tenancy model: USING/WITH CHECK is `true` (or a
//     recognised tautology), the policy keys on caller identity but never the
//     tenant key, or WITH CHECK is weaker than USING. Review-tier: a hit is a
//     REVIEW candidate (an intentional public catalog is legitimate), not a
//     confirmed defect.
//   definer-authz / definer-oracle — a SECURITY DEFINER function with no
//     auth.uid()/auth.jwt() caller check in its body: `definer-authz` when it
//     does a privileged write/grant (escalation), `definer-oracle` when it
//     takes parameters and reads/returns data (D-091 #27: a parameter-only
//     DEFINER reader is a status/existence enumeration oracle — the accepted
//     #2006 tenant_is_active() oracle is the canonical baselined instance).
//   rls-initplan — a policy clause calling auth.uid()/role()/jwt()/email() or
//     current_setting() bare (not `(select …)`-wrapped), re-evaluated per row —
//     Supabase's auth_rls_initplan advisor lint read from migration SQL.
//
// Disclosed limitation (same as Harvey's): migrations are cumulative and this
// does not track `drop policy`/re-creates, so a policy rewritten later can be
// reported from its original file. The live advisor/rls-snapshot is ground truth.
//
// FREEZE-EXISTING / BLOCK-NEW: pre-existing hits are frozen in
// scripts/rls-semantics-baseline.txt (count-keyed by <kind>::<identity>). The
// guard fails only on NEW hits. Fails loud when zero migration files are found.
//
// Usage: tsx scripts/check-rls-policy-semantics.ts [migrationsDir ...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/rls-semantics-baseline.txt");

// --- migration SQL parsing (ported from Harvey src/migration-sql-parse.ts) ---

function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

// Reads a parenthesised expression starting at `open` (index of its "("),
// tracking nesting and single-quoted literals. Null if the parens never balance.
function readBalanced(sql: string, open: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i).trim();
    }
  }
  return null;
}

// Statement text from `start` to its terminating ";" at paren depth 0.
function statementText(sql: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (c === "'") inString = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) return sql.slice(start, i);
  }
  return null;
}

export interface ParsedPolicy {
  schema: string;
  table: string;
  name: string;
  cmd: string; // SELECT / INSERT / UPDATE / DELETE / ALL
  qual: string | null; // USING body
  withCheck: string | null; // WITH CHECK body
}

interface UnparsedPolicy {
  schema: string;
  table: string;
  name: string;
  reason: string;
}

const CREATE_POLICY = /create policy\s+(?:"([^"]+)"|(\w+))\s+on\s+(?:(\w+)\.)?(\w+)/gi;
const FOR_CMD = /\bfor\s+(all|select|insert|update|delete)\b/i;
const USING_AT = /\busing\s*\(/i;
const WITH_CHECK_AT = /\bwith\s+check\s*\(/i;

function clauseAt(stmt: string, marker: RegExp): { value: string | null; failed: boolean } {
  const m = marker.exec(stmt);
  if (!m) return { value: null, failed: false };
  const open = stmt.indexOf("(", m.index);
  const body = readBalanced(stmt, open);
  return body === null ? { value: null, failed: true } : { value: body, failed: false };
}

export function parsePolicies(sql: string): { policies: ParsedPolicy[]; unparsed: UnparsedPolicy[] } {
  const clean = stripLineComments(sql);
  const policies: ParsedPolicy[] = [];
  const unparsed: UnparsedPolicy[] = [];
  for (const m of clean.matchAll(CREATE_POLICY)) {
    const name = (m[1] ?? m[2])!;
    const schema = m[3] ?? "public";
    const table = m[4]!;
    const stmt = statementText(clean, m.index);
    if (stmt === null) {
      unparsed.push({ schema, table, name, reason: "no terminating ';' — clauses unreadable" });
      continue;
    }
    const qual = clauseAt(stmt, USING_AT);
    const withCheck = clauseAt(stmt, WITH_CHECK_AT);
    if (qual.failed || withCheck.failed) {
      unparsed.push({ schema, table, name, reason: `unbalanced parentheses in ${qual.failed ? "USING" : "WITH CHECK"}` });
      continue;
    }
    policies.push({ schema, table, name, cmd: (FOR_CMD.exec(stmt)?.[1] ?? "ALL").toUpperCase(), qual: qual.value, withCheck: withCheck.value });
  }
  return { policies, unparsed };
}

export interface DefinerFunction {
  schema: string;
  name: string;
  argNames: string[];
  body: string;
}

const DEFINER_FUNCTION =
  /create\s+(?:or\s+replace\s+)?function\s+(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)[\s\S]*?security\s+definer[\s\S]*?as\s+\$(\w*)\$([\s\S]*?)\$\4\$/gi;

export function parseDefinerFunctions(sql: string): DefinerFunction[] {
  return [...stripLineComments(sql).matchAll(DEFINER_FUNCTION)].map((m) => ({
    schema: m[1] ?? "public",
    name: m[2]!,
    argNames: m[3]!.split(",").map((a) => a.trim()).filter(Boolean).map((a) => a.split(/\s+/)[0]!),
    body: m[5]!,
  }));
}

// --- policy semantic review (ported from Harvey src/rls-policy-review.ts) ----

const CALLER_REF = /auth\.(uid|jwt|role)\s*\(\)|current_setting\s*\(/i;
const WRITE_CMDS = new Set(["INSERT", "UPDATE", "ALL"]);
const USING_GATED_CMDS = new Set(["SELECT", "UPDATE", "DELETE", "ALL"]);
const CLAUSE_TRUE = /^\s*\(*\s*true\s*\)*\s*$/i;

// Collapse recognised tautologies (`col IS NULL OR col IS NOT NULL`, `col = col`)
// to `true` so a disguised USING(true) is still caught. Tight on purpose: a
// genuine predicate never matches.
function collapseAlwaysTrue(clause: string): string {
  return clause
    .replace(/([\w."]+)\s+is\s+(not\s+)?null\s+or\s+([\w."]+)\s+is\s+(not\s+)?null/gi, (m, a: string, notA, b: string, notB) =>
      a.toLowerCase() === b.toLowerCase() && Boolean(notA) !== Boolean(notB) ? "true" : m,
    )
    .replace(/([\w."]+)\s*=\s*([\w."]+)/gi, (m, a: string, b: string) => (a.toLowerCase() === b.toLowerCase() ? "true" : m));
}

function isAlwaysTrue(clause: string | null): boolean {
  return clause !== null && CLAUSE_TRUE.test(collapseAlwaysTrue(clause));
}

function refsWord(clause: string | null, word: string): boolean {
  return clause != null && new RegExp(`\\b${word}\\b`, "i").test(clause);
}

// A predicate binding a row value directly to the caller — genuine owner-level
// isolation (`user_id = auth.uid()`, `(select auth.uid()) = id`, …).
const OWNER_BINDING =
  /[\w.)\]]+\s*=\s*\(?\s*(?:select\s+)?auth\.uid\s*\(\)|auth\.uid\s*\(\)\s*(?:as\s+\w+\s*)?\)?(?:::\w+)?\s*=\s*[\w.)\]]+/i;

function ownerBound(clause: string | null): boolean {
  return clause != null && OWNER_BINDING.test(clause);
}

export interface TenancyModel {
  tenantKey: string;
  mode?: "per-tenant" | "per-user";
}

// Judge one policy against the table's tenancy model. Returns a reason string
// (a review candidate) or null (clear). Ported reviewPolicy(), reasons condensed.
export function reviewPolicy(p: ParsedPolicy, model: TenancyModel): string | null {
  const callerRef = (p.qual != null && CALLER_REF.test(p.qual)) || (p.withCheck != null && CALLER_REF.test(p.withCheck));
  const isWrite = WRITE_CMDS.has(p.cmd.toUpperCase());

  const checkTrue = (): string | null =>
    isWrite && isAlwaysTrue(p.withCheck)
      ? `WITH CHECK is "true" — writes accept any row the caller submits`
      : null;

  if ((model.mode ?? "per-tenant") === "per-user") {
    const usingBound = ownerBound(p.qual);
    const checkBound = ownerBound(p.withCheck);
    if (callerRef && !usingBound && !checkBound) {
      return "references the caller but never binds a row column to auth.uid() — ownership indirect/unscoped";
    }
    if (isWrite && usingBound && p.withCheck != null && !checkBound) {
      return "USING binds to auth.uid() but WITH CHECK does not — writes not owner-constrained";
    }
    return checkTrue();
  }

  const key = model.tenantKey;
  const qualKey = refsWord(p.qual, key);
  const checkKey = refsWord(p.withCheck, key);
  if (callerRef && !qualKey && !checkKey) {
    return `keys on caller identity but never references the tenant key "${key}" — may isolate on the wrong column`;
  }
  if (isWrite && qualKey && p.withCheck != null && !checkKey) {
    return `USING constrains by "${key}" but WITH CHECK does not — writes not tenant-constrained`;
  }
  if (checkTrue()) return checkTrue();
  if (USING_GATED_CMDS.has(p.cmd.toUpperCase()) && isAlwaysTrue(p.qual)) {
    return `USING is "true" on a table declaring tenant key "${key}" — every caller reaches every tenant's rows`;
  }
  return null;
}

// --- tenancy inference (ported from Harvey checkMigrationPolicySemantics) ----

const TENANT_KEY_CANDIDATES = ["tenant_id", "org_id", "organization_id", "workspace_id", "account_id", "company_id"];

function tableBody(sql: string, table: string): string | null {
  const m = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:\\w+\\.)?${table}\\s*\\(`, "i").exec(sql);
  if (!m) return null;
  const open = sql.indexOf("(", m.index);
  const end = sql.indexOf(");", open);
  return sql.slice(open, end === -1 ? undefined : end);
}

export function inferTenancyModel(allSql: string, table: string): TenancyModel {
  const body = tableBody(allSql, table);
  if (body === null) return { tenantKey: "", mode: "per-user" };
  const key = TENANT_KEY_CANDIDATES.find((c) => new RegExp(`[(,\\n]\\s*${c}\\s+\\w`, "i").test(body));
  return key ? { tenantKey: key } : { tenantKey: "", mode: "per-user" };
}

// --- definer caller-authz (ported from Harvey src/definer-review.ts) ---------

const PRIVILEGED_WRITE = /\b(update|insert\s+into|delete\s+from|grant)\b/i;
const CALLER_AUTH = /auth\.(uid|jwt)\s*\(\)/i;

export function needsAuthzReview(fn: DefinerFunction): boolean {
  return PRIVILEGED_WRITE.test(fn.body) && !CALLER_AUTH.test(fn.body);
}

// D-091 #27 widening beyond Harvey's write-only rule: a parameter-taking
// DEFINER READER with no caller check is a status/existence oracle — any role
// it's granted to can probe arbitrary ids (#2006's tenant_is_active class).
// Zero-arg readers are excluded (nothing to enumerate by parameter).
export function isDefinerOracle(fn: DefinerFunction): boolean {
  return (
    fn.argNames.length > 0 &&
    !CALLER_AUTH.test(fn.body) &&
    !PRIVILEGED_WRITE.test(fn.body) && // the write case is definer-authz's
    /\bselect\b|\breturn\s+query\b/i.test(fn.body)
  );
}

// --- initplan (ported from Harvey checkMigrationRlsInitplanStatic) -----------

const AUTH_FN_CALL = /\bauth\.(uid|role|jwt|email)\s*\(\s*\)|\bcurrent_setting\s*\(/gi;

// Whether the call at `index` is already `(select …)`-wrapped (hoisted).
export function isSelectWrapped(clause: string, index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = clause[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) return /^\s*select\b/i.test(clause.slice(i + 1, index));
      depth--;
    }
  }
  return false;
}

export function bareInitplanCalls(p: ParsedPolicy): string[] {
  const bare: string[] = [];
  for (const [clauseName, clause] of [["USING", p.qual], ["WITH CHECK", p.withCheck]] as const) {
    if (!clause) continue;
    for (const m of clause.matchAll(AUTH_FN_CALL)) {
      if (!isSelectWrapped(clause, m.index)) bare.push(`${m[0].replace(/\s+/g, "").replace(/\($/, "")} in ${clauseName}`);
    }
  }
  return bare;
}

// --- orchestration -----------------------------------------------------------

export interface RlsFinding {
  kind: "policy-semantics" | "policy-unparsed" | "definer-authz" | "definer-oracle" | "rls-initplan";
  key: string; // <kind>::<identity> — line-independent baseline identity
  file: string;
  line: number;
  detail: string;
}

function lineAt(sql: string, needle: string): number {
  const at = sql.toLowerCase().indexOf(needle.toLowerCase());
  return at >= 0 ? sql.slice(0, at).split("\n").length : 1;
}

export function scanMigrationSet(files: { file: string; sql: string }[]): RlsFinding[] {
  const findings: RlsFinding[] = [];
  const allSql = stripLineComments(files.map((f) => f.sql).join("\n"));
  const models = new Map<string, TenancyModel>();
  const model = (table: string): TenancyModel => {
    let m = models.get(table);
    if (!m) {
      m = inferTenancyModel(allSql, table);
      models.set(table, m);
    }
    return m;
  };

  for (const { file, sql } of files) {
    const { policies, unparsed } = parsePolicies(sql);
    for (const u of unparsed) {
      // Fail loud: a policy we couldn't read must not be indistinguishable from
      // a clean one.
      findings.push({
        kind: "policy-unparsed",
        key: `policy-unparsed::${u.schema}.${u.table}.${u.name}`,
        file,
        line: lineAt(sql, `policy ${u.name}`),
        detail: `${u.schema}.${u.table}.${u.name}: ${u.reason} — not assessed, NOT clean`,
      });
    }
    for (const p of policies) {
      const id = `${p.schema}.${p.table}.${p.name}`;
      const reason = reviewPolicy(p, model(p.table));
      if (reason) {
        findings.push({ kind: "policy-semantics", key: `policy-semantics::${id}`, file, line: lineAt(sql, `policy ${p.name}`), detail: `${id} (${p.cmd}): ${reason}` });
      }
      const bare = bareInitplanCalls(p);
      if (bare.length > 0) {
        findings.push({ kind: "rls-initplan", key: `rls-initplan::${id}`, file, line: lineAt(sql, `policy ${p.name}`), detail: `${id}: ${bare.join(", ")} not (select …)-wrapped — re-evaluated per row` });
      }
    }
    for (const fn of parseDefinerFunctions(sql)) {
      const sig = `${fn.schema}.${fn.name}(${fn.argNames.join(", ")})`;
      const line = lineAt(sql, `function ${fn.schema}.${fn.name}`);
      if (needsAuthzReview(fn)) {
        findings.push({
          kind: "definer-authz",
          key: `definer-authz::${sig}`,
          file,
          line,
          detail: `${sig}: SECURITY DEFINER privileged write/grant with no auth.uid()/auth.jwt() caller check (D-091 #27)`,
        });
      } else if (isDefinerOracle(fn)) {
        findings.push({
          kind: "definer-oracle",
          key: `definer-oracle::${sig}`,
          file,
          line,
          detail: `${sig}: parameter-only SECURITY DEFINER reader with no caller check — status/existence oracle (D-091 #27, refs #2006)`,
        });
      }
    }
  }
  return findings;
}

// --- baseline plumbing (house FREEZE-EXISTING / BLOCK-NEW pattern) -----------

export function loadBaseline(file: string = BASELINE_FILE): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const count = Number(line.slice(0, sp));
    const key = line.slice(sp + 1);
    if (Number.isFinite(count) && count > 0 && key) map.set(key, count);
  }
  return map;
}

function defaultDirs(): string[] {
  return fs
    .readdirSync(path.join(ROOT, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(ROOT, "apps", e.name, "supabase/migrations"))
    .filter((d) => fs.existsSync(d));
}

function main(): void {
  const argDirs = process.argv.slice(2);
  const dirs = argDirs.length > 0 ? argDirs.map((d) => path.resolve(d)) : defaultDirs();
  const files = dirs.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ file: path.relative(ROOT, path.join(dir, f)), sql: fs.readFileSync(path.join(dir, f), "utf8") })),
  );
  if (files.length === 0) {
    console.error("rls-policy-semantics guard: no migration .sql files found — check paths.");
    process.exit(1);
  }

  const findings = scanMigrationSet(files);
  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.key, (liveCounts.get(f.key) ?? 0) + 1);

  const baseline = loadBaseline();
  const fresh: RlsFinding[] = [];
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = (seen.get(f.key) ?? 0) + 1;
    seen.set(f.key, n);
    if (n > (baseline.get(f.key) ?? 0)) fresh.push(f);
  }
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key) ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "rls-policy-semantics guard: NEW finding(s) — review the policy/function semantics; if reviewed-and-accepted, add the key to scripts/rls-semantics-baseline.txt with a reason:\n",
    );
    for (const f of fresh) console.error(`  [${f.kind}] ${f.file}:${f.line}  ${f.detail}`);
    console.error(`\n${fresh.length} NEW finding(s) beyond scripts/rls-semantics-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(`rls-policy-semantics guard passed: ${findings.length} pre-existing finding(s) baselined, 0 new${note}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
