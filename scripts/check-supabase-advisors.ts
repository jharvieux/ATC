// Supabase Security Advisor CI check (#1635).
//
// ATC gates RLS/grants/policy at the SQL layer (rls:check, grants:check,
// check:policy-snapshot), but nothing asserts on the Supabase PROJECT/PLATFORM
// config — the layer the Security Advisor covers (leaked-password protection,
// SECURITY DEFINER RPC exposure, extensions in public, RLS-without-policy). A
// live WARN (auth_leaked_password_protection on atc-main) was persisting
// silently. This polls the Management API advisor endpoint on a schedule and
// fails (→ the workflow opens/updates a tracked issue) on any WARN+ finding not
// in the accepted-risk baseline.
//
// Endpoint (experimental): GET https://api.supabase.com/v1/projects/{ref}/advisors/security
//   Auth: Bearer <SUPABASE_ACCESS_TOKEN> (PAT with database:read + advisors_read).
//   Response: { lints: Lint[] }.
//
// Operator prerequisite: SUPABASE_ACCESS_TOKEN must exist as a CI secret (no
// Supabase Management token exists in CI today — see docs/runbooks/supabase-advisor-check.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactSecrets } from "./lib/redact-secrets";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, ".github/supabase-advisor-config.json");
const BASELINE_FILE = path.join(ROOT, "scripts/supabase-advisor-baseline.txt");
const API_BASE = process.env.SUPABASE_API_BASE ?? "https://api.supabase.com";

// HONESTY: this shape is inferred from the MCP `get_advisors` transport, NOT
// verified against the live HTTP Management API (GET .../advisors/security) —
// no SUPABASE_ACCESS_TOKEN exists in CI yet, so this endpoint has never been
// called from here. If the raw HTTP body differs (e.g. no `lints[]`, or
// `cache_key` absent), fetchLints throws and the scheduled run fails loud —
// it can't silently pass on a mis-parse. Confirm against a real response on the
// first scheduled run once the token lands, and correct this interface then.
export interface Lint {
  name: string;
  title?: string;
  level: string; // INFO | WARN | ERROR
  categories?: string[];
  detail?: string;
  remediation?: string;
  cache_key: string;
}

export interface ProjectConfig {
  name: string;
  ref: string;
}

export interface AdvisorConfig {
  failLevels: string[];
  projects: ProjectConfig[];
}

// Pure: given a project's lints, return the WARN+ findings not in the baseline.
// Baseline keys are `<projectName>:<cache_key>` (project-scoped — the same
// cache_key can legitimately differ in intent across projects).
export function newFindings(
  projectName: string,
  lints: Lint[],
  baseline: Set<string>,
  failLevels: string[],
): Lint[] {
  const fail = new Set(failLevels.map((l) => l.toUpperCase()));
  return lints.filter(
    (l) => fail.has((l.level ?? "").toUpperCase()) && !baseline.has(`${projectName}:${l.cache_key}`),
  );
}

function loadConfig(): AdvisorConfig {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    throw new Error("supabase-advisor-config.json: `projects` must be a non-empty array.");
  }
  return { failLevels: raw.failLevels ?? ["WARN", "ERROR"], projects: raw.projects };
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

async function fetchLints(ref: string, token: string): Promise<Lint[]> {
  const res = await fetch(`${API_BASE}/v1/projects/${ref}/advisors/security`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`advisor fetch for ${ref} failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { lints?: Lint[] };
  if (!Array.isArray(body.lints)) throw new Error(`advisor response for ${ref} has no lints[]`);
  return body.lints;
}

async function main(): Promise<void> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    // Fail loud — a missing token means the check silently can't run, which is
    // exactly the blind spot this guard exists to close.
    console.error(
      "Supabase advisor check: SUPABASE_ACCESS_TOKEN not set. Add it as a CI secret " +
        "(PAT with database:read + advisors_read). See docs/runbooks/supabase-advisor-check.md.",
    );
    process.exit(1);
  }
  const config = loadConfig();
  const baseline = loadBaseline();
  const allFindings: { project: string; lint: Lint }[] = [];

  for (const project of config.projects) {
    const lints = await fetchLints(project.ref, token);
    for (const lint of newFindings(project.name, lints, baseline, config.failLevels)) {
      allFindings.push({ project: project.name, lint });
    }
  }

  if (allFindings.length > 0) {
    console.error("Supabase advisor check: new WARN+ security finding(s) not in the baseline:\n");
    for (const { project, lint } of allFindings) {
      console.error(`  [${project}] ${lint.level} ${lint.name}: ${lint.detail ?? lint.title ?? ""}`);
      console.error(`    baseline key: ${project}:${lint.cache_key}`);
      if (lint.remediation) console.error(`    remediation: ${lint.remediation}`);
    }
    console.error(
      `\n${allFindings.length} finding(s). FIX (preferred) or, if accepted risk, add the ` +
        "`baseline key` line to scripts/supabase-advisor-baseline.txt with a reason.",
    );
    process.exit(1);
  }
  console.log(
    `Supabase advisor check passed: ${config.projects.length} project(s) scanned, 0 new WARN+ finding(s).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Supabase advisor check errored:", redactSecrets(err));
    process.exit(1);
  });
}
