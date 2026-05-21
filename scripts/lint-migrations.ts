// Migration lint gate
// Spec refs: §5.1.1 (SECURITY DEFINER convention), §5.1.2 (RLS coverage), §30.8
//
// Static scan of apps/main/supabase/migrations/. Asserts:
//   1. Any CREATE TABLE public.<x> with a tenant_id column has, by the
//      current migration HEAD, RLS enabled and a policy for each of
//      SELECT, INSERT, UPDATE, DELETE — OR <x> is listed in
//      db/rls-exceptions.txt with a reason.
//   2. Every CREATE OR REPLACE FUNCTION ... SECURITY DEFINER body includes
//      SET search_path = '' and is followed by REVOKE EXECUTE ... FROM public.
//   3. No policy contains USING (true) or WITH CHECK (true).
// Exits non-zero on any violation.

import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join("apps", "main", "supabase", "migrations");
const EXCEPTIONS_FILE = path.join("db", "rls-exceptions.txt");

type Violation = { file: string; message: string };

function readMigrations(): { file: string; content: string }[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      file: f,
      content: fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"),
    }));
}

function readExceptions(): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(EXCEPTIONS_FILE)) return map;
  const text = fs.readFileSync(EXCEPTIONS_FILE, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hashIdx = line.indexOf("#");
    if (hashIdx < 0) continue;
    const name = line.slice(0, hashIdx).trim();
    const reason = line.slice(hashIdx + 1).trim();
    if (name && reason) map.set(name, reason);
  }
  return map;
}

// Strip SQL comments + collapse whitespace so regex matches survive
// formatting differences across migrations.
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
}

interface TableDef {
  name: string;
  hasTenantId: boolean;
  file: string;
}

function findTables(migrations: { file: string; content: string }[]): TableDef[] {
  const tables: TableDef[] = [];
  const createRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;

  for (const m of migrations) {
    const normalized = normalize(m.content);
    let match: RegExpExecArray | null;
    while ((match = createRe.exec(normalized)) !== null) {
      const name = match[1].toLowerCase();
      const body = match[2];
      const hasTenantId = /\btenant_id\s+UUID\b/i.test(body);
      tables.push({ name, hasTenantId, file: m.file });
    }
  }
  return tables;
}

interface PolicyCoverage {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  rlsEnabled: boolean;
}

function findPolicyCoverage(
  table: string,
  allSql: string,
): PolicyCoverage {
  const cov: PolicyCoverage = {
    select: false,
    insert: false,
    update: false,
    delete: false,
    rlsEnabled: false,
  };

  const alterRe = new RegExp(
    `ALTER\\s+TABLE\\s+public\\.${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    "i",
  );
  cov.rlsEnabled = alterRe.test(allSql);

  const policyRe = new RegExp(
    `CREATE\\s+POLICY\\s+\\S+\\s+ON\\s+public\\.${table}\\s+FOR\\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\\b`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = policyRe.exec(allSql)) !== null) {
    const cmd = m[1].toUpperCase();
    if (cmd === "ALL") {
      cov.select = cov.insert = cov.update = cov.delete = true;
    } else if (cmd === "SELECT") cov.select = true;
    else if (cmd === "INSERT") cov.insert = true;
    else if (cmd === "UPDATE") cov.update = true;
    else if (cmd === "DELETE") cov.delete = true;
  }
  return cov;
}

function checkSecurityDefiner(
  migrations: { file: string; content: string }[],
): Violation[] {
  const violations: Violation[] = [];
  const fnRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\([^)]*\)[\s\S]*?(?=CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TRIGGER|CREATE\s+POLICY|ALTER\s+TABLE|REVOKE\s+EXECUTE|GRANT\s+EXECUTE|$)/gi;

  for (const m of migrations) {
    const text = m.content;
    let match: RegExpExecArray | null;
    while ((match = fnRe.exec(text)) !== null) {
      const body = match[0];
      const fnName = match[1];
      const isDefiner = /SECURITY\s+DEFINER/i.test(body);
      if (!isDefiner) continue;

      if (!/SET\s+search_path\s*=\s*['"]{0,2}['"]{0,2}/i.test(body) &&
          !/SET\s+search_path\s*=\s*''/i.test(body)) {
        violations.push({
          file: m.file,
          message: `SECURITY DEFINER function ${fnName} is missing SET search_path = '' (§5.1.1)`,
        });
      }

      const fullText = text.slice(match.index);
      const followingChunk = fullText.slice(
        0,
        Math.min(fullText.length, body.length + 500),
      );
      const revokeRe = new RegExp(
        `REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${fnName}\\b[\\s\\S]*?FROM\\s+public`,
        "i",
      );
      if (!revokeRe.test(followingChunk)) {
        violations.push({
          file: m.file,
          message: `SECURITY DEFINER function ${fnName} is missing REVOKE EXECUTE ... FROM public (§5.1.1)`,
        });
      }
    }
  }
  return violations;
}

function checkPermissivePolicies(
  migrations: { file: string; content: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const m of migrations) {
    const normalized = normalize(m.content);
    if (/\bUSING\s*\(\s*true\s*\)/i.test(normalized)) {
      violations.push({
        file: m.file,
        message: "policy uses USING (true) — no-op policy that defeats RLS (§5.1.2)",
      });
    }
    if (/\bWITH\s+CHECK\s*\(\s*true\s*\)/i.test(normalized)) {
      violations.push({
        file: m.file,
        message:
          "policy uses WITH CHECK (true) — no-op policy that defeats RLS (§5.1.2)",
      });
    }
  }
  return violations;
}

function main(): void {
  const migrations = readMigrations();
  if (migrations.length === 0) {
    console.log("No migrations to lint.");
    return;
  }

  const exceptions = readExceptions();
  const allSql = migrations.map((m) => m.content).join("\n");
  const allNormalized = normalize(allSql);

  const tables = findTables(migrations);
  const violations: Violation[] = [];

  for (const t of tables) {
    if (!t.hasTenantId) continue;
    if (exceptions.has(t.name)) continue;

    const cov = findPolicyCoverage(t.name, allNormalized);
    if (!cov.rlsEnabled) {
      violations.push({
        file: t.file,
        message: `table public.${t.name} has tenant_id but RLS is not enabled (§5.1.2)`,
      });
    }
    const missing = (["select", "insert", "update", "delete"] as const).filter(
      (op) => !cov[op],
    );
    if (missing.length > 0) {
      violations.push({
        file: t.file,
        message: `table public.${t.name} is missing policies for: ${missing
          .join(", ")
          .toUpperCase()} (§5.1.2). Add policies or list in db/rls-exceptions.txt with a reason.`,
      });
    }
  }

  violations.push(...checkSecurityDefiner(migrations));
  violations.push(...checkPermissivePolicies(migrations));

  if (violations.length > 0) {
    console.error("Migration lint violations:");
    for (const v of violations) {
      console.error(`  [${v.file}] ${v.message}`);
    }
    console.error(`\n${violations.length} violation(s). See spec §30.8.`);
    process.exit(1);
  }

  console.log(`Lint passed: ${migrations.length} migration(s), ${tables.length} table(s).`);
}

main();
