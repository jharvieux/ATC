// Compare live RLS state against the committed snapshot for either DB.
//
// Usage:
//   tsx scripts/rls-snapshot-diff.ts                # both main + rag
//   tsx scripts/rls-snapshot-diff.ts --target=main  # main only
//   tsx scripts/rls-snapshot-diff.ts --target=rag   # rag only
//
// Exit code: 0 if no drift on any checked target, 1 if any drift detected.
// A missing env var for a target SKIPS that target with a warning (doesn't fail).

import { readFileSync } from "fs";
import { join } from "path";
import { generateSnapshot } from "./rls-snapshot";

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
  return join(process.cwd(), "db", `rls-snapshot-${target}.sql`);
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
        `Run: pnpm rls:snapshot:${target}`,
    };
  }

  let live: string;
  try {
    live = await generateSnapshot(target);
  } catch (err) {
    return {
      status: "drift",
      message: `[${target}] Error fetching live RLS state: ${(err as Error).message}`,
    };
  }

  const diffOutput = diff(committed.trimEnd(), live.trimEnd());
  if (!diffOutput) {
    return { status: "ok", message: `[${target}] no drift` };
  }
  return {
    status: "drift",
    message:
      `[${target}] RLS DRIFT DETECTED\n` +
      `Lines prefixed with '-' are in the committed snapshot but not live.\n` +
      `Lines prefixed with '+' are live but not in the committed snapshot.\n` +
      `Update with: pnpm rls:snapshot:${target}\n\n` +
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
  let anyDrift = false;
  let anyChecked = false;

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
    }
  }

  if (!anyChecked) {
    // GitHub does not pass repo secrets to Dependabot-triggered workflow
    // runs, so SUPABASE_DB_URL / SUPABASE_RAG_DB_URL are absent there and
    // no target can be checked. That's expected — dependency bumps never
    // touch migrations or RLS policies — so the workflow sets
    // RLS_ALLOW_NO_TARGETS=true for Dependabot and we pass instead of
    // failing. On every other PR the secrets ARE present, so an absent
    // target is a real misconfiguration and still fails loud.
    if (process.env.RLS_ALLOW_NO_TARGETS === "true") {
      console.log(
        "No targets checked, but RLS_ALLOW_NO_TARGETS=true — passing. " +
          "(Expected on Dependabot PRs: repo secrets aren't available to " +
          "bot-triggered runs; dependency bumps don't change RLS.)",
      );
      process.exit(0);
    }
    console.error(
      "No targets checked — set SUPABASE_DB_URL and/or SUPABASE_RAG_DB_URL.",
    );
    process.exit(1);
  }

  process.exit(anyDrift ? 1 : 0);
}

main();
