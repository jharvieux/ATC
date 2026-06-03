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

export type DiffReason =
  | "no-targets-pass"
  | "no-targets-fail"
  | "skip-fail"
  | "drift"
  | "clean";

export interface DiffDecision {
  pass: boolean;
  reason: DiffReason;
}

// Pure exit decision for a diff run, extracted so the fail-closed behavior is
// unit-testable without a live DB (tests/unit/scripts/grants-snapshot-diff.test.ts).
//
// Fail-closed (D-091): a target skipped because its connection string is unset
// means a prod secret is half-configured — checking only main while rag silently
// passes would let a rag regression through the blocking gate. So a skip blocks
// unless allowNoTargets is set (Dependabot, which can't receive the secrets).
// rls-snapshot-diff can tolerate a skip because its TEST URLs are set together at
// the job level and always present; the grants secrets are provisioned separately.
export function decideOutcome(state: {
  anyChecked: boolean;
  anyDrift: boolean;
  anySkipped: boolean;
  allowNoTargets: boolean;
}): DiffDecision {
  if (!state.anyChecked) {
    return state.allowNoTargets
      ? { pass: true, reason: "no-targets-pass" }
      : { pass: false, reason: "no-targets-fail" };
  }
  if (state.anySkipped && !state.allowNoTargets) {
    return { pass: false, reason: "skip-fail" };
  }
  return state.anyDrift
    ? { pass: false, reason: "drift" }
    : { pass: true, reason: "clean" };
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

  const decision = decideOutcome({ anyChecked, anyDrift, anySkipped, allowNoTargets });
  switch (decision.reason) {
    case "no-targets-pass":
      console.log("No targets checked, but GRANTS_ALLOW_NO_TARGETS=true — passing (Dependabot run).");
      break;
    case "no-targets-fail":
      console.error("No targets checked — set SUPABASE_DB_URL and/or SUPABASE_RAG_DB_URL.");
      break;
    case "skip-fail":
      console.error(
        "A selected target was skipped (its connection string is unset), but GRANTS_ALLOW_NO_TARGETS is not true.\n" +
          "Set the missing SUPABASE_DB_URL / SUPABASE_RAG_DB_URL, or scope the run with --target=main|rag.",
      );
      break;
    // "drift" / "clean" were already logged per-target inside the loop above.
  }

  process.exit(decision.pass ? 0 : 1);
}

// Module-as-script: only run when invoked directly, so decideOutcome can be
// imported by the unit test without triggering a DB connection / process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
