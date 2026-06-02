// Compare live table-GRANTS against the committed snapshot for either DB.
//
// Usage:
//   tsx scripts/grants-snapshot-diff.ts                # both main + rag
//   tsx scripts/grants-snapshot-diff.ts --target=main  # main only
//   tsx scripts/grants-snapshot-diff.ts --target=rag   # rag only
//
// Exit code: 0 if no drift on any checked target, 1 if any drift detected.
// A missing env var for a target SKIPS that target with a warning (doesn't fail).
//
// The committed snapshot codifies the intended least-privilege grants of the
// SERVING database (post-#545). Standard hosted/local test projects auto-grant
// service_role via ALTER DEFAULT PRIVILEGES that the serving DB was provisioned
// without (see scripts/local-pg-grants.sql), so this must be diffed against the
// serving DB it was generated from — not a more-permissive test project.

import { readFileSync } from "fs";
import { join } from "path";
import { generateSnapshot } from "./grants-snapshot";

type Target = "main" | "rag";
const ALL_TARGETS: readonly Target[] = ["main", "rag"];

function parseTarget(argv: string[]): Target | "all" {
  const arg = argv.find((a) => a.startsWith("--target="));
  if (!arg) return "all";
  const value = arg.slice("--target=".length);
  if (value !== "main" && value !== "rag") {
    throw new Error(`--target must be 'main' or 'rag' (got '${value}')`);
  }
  return value;
}

function snapshotPath(target: Target): string {
  return join(process.cwd(), "db", `grants-snapshot-${target}.sql`);
}

function envVarFor(target: Target): string {
  return target === "main" ? "SUPABASE_DB_URL" : "SUPABASE_RAG_DB_URL";
}

function diff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const result: string[] = [];

  const maxLen = Math.max(aLines.length, bLines.length);
  let hasDiff = false;

  for (let i = 0; i < maxLen; i++) {
    const aLine = i < aLines.length ? aLines[i] : undefined;
    const bLine = i < bLines.length ? bLines[i] : undefined;

    if (aLine !== bLine) {
      hasDiff = true;
      if (aLine !== undefined) result.push(`- ${aLine}`);
      if (bLine !== undefined) result.push(`+ ${bLine}`);
    }
  }

  return hasDiff ? result.join("\n") : "";
}

async function checkTarget(target: Target): Promise<{ status: "ok" | "drift" | "skipped"; message: string }> {
  if (!process.env[envVarFor(target)]) {
    return {
      status: "skipped",
      message: `[${target}] SKIPPED — ${envVarFor(target)} not set`,
    };
  }

  let committed: string;
  try {
    committed = readFileSync(snapshotPath(target), "utf8");
  } catch {
    return {
      status: "drift",
      message:
        `[${target}] Could not read ${snapshotPath(target)}.\n` +
        `Run: pnpm grants:snapshot:${target}`,
    };
  }

  let live: string;
  try {
    live = await generateSnapshot(target);
  } catch (err) {
    return {
      status: "drift",
      message: `[${target}] Error fetching live grants: ${(err as Error).message}`,
    };
  }

  const diffOutput = diff(committed.trimEnd(), live.trimEnd());
  if (!diffOutput) {
    return { status: "ok", message: `[${target}] no drift` };
  }
  return {
    status: "drift",
    message:
      `[${target}] GRANTS DRIFT DETECTED\n` +
      `Lines prefixed with '-' are in the committed snapshot but not live.\n` +
      `Lines prefixed with '+' are live but not in the committed snapshot.\n` +
      `Update with: pnpm grants:snapshot:${target}\n\n` +
      diffOutput,
  };
}

async function main() {
  let selection: Target | "all";
  try {
    selection = parseTarget(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const targets: Target[] = selection === "all" ? [...ALL_TARGETS] : [selection];
  const allowNoTargets = process.env.GRANTS_ALLOW_NO_TARGETS === "true";
  let anyDrift = false;
  let anyChecked = false;
  let anySkipped = false;

  for (const target of targets) {
    const result = await checkTarget(target);
    if (result.status === "drift") {
      console.error(result.message);
      anyDrift = true;
      anyChecked = true;
    } else if (result.status === "ok") {
      console.log(result.message);
      anyChecked = true;
    } else {
      console.warn(result.message);
      anySkipped = true;
    }
  }

  if (!anyChecked) {
    // Safe to pass here only because dependency bumps never touch migrations or
    // grants. The workflow sets this flag exclusively for Dependabot (which
    // can't receive the DB-URL secrets); see deploy.yml.
    if (allowNoTargets) {
      console.log("No targets checked, but GRANTS_ALLOW_NO_TARGETS=true — passing (Dependabot run).");
      process.exit(0);
    }
    console.error(
      "No targets checked — set SUPABASE_DB_URL and/or SUPABASE_RAG_DB_URL.",
    );
    process.exit(1);
  }

  // Fail-closed (D-091): a target skipped for an unset connection string means a
  // prod secret is half-configured. Checking only main while rag silently passes
  // would let a rag regression through the blocking gate. (rls-snapshot-diff can
  // tolerate a skip because its TEST URLs are set together at the job level and
  // are always present; the grants secrets are provisioned separately, so a
  // partial config is a real failure mode here.) Dependabot is exempt via the flag.
  if (anySkipped && !allowNoTargets) {
    console.error(
      "A selected target was skipped (its connection string is unset), but GRANTS_ALLOW_NO_TARGETS is not true.\n" +
        "Set the missing SUPABASE_DB_URL / SUPABASE_RAG_DB_URL, or scope the run with --target=main|rag.",
    );
    process.exit(1);
  }

  process.exit(anyDrift ? 1 : 0);
}

main();
