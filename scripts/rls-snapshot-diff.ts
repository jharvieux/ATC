import { readFileSync } from "fs";
import { join } from "path";
import { generateSnapshot } from "./rls-snapshot";

const SNAPSHOT_PATH = join(process.cwd(), "db", "rls-snapshot.sql");

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

async function main() {
  let committed: string;
  try {
    committed = readFileSync(SNAPSHOT_PATH, "utf8");
  } catch {
    console.error(
      `Error: Could not read ${SNAPSHOT_PATH}.\n` +
        "Run: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql",
    );
    process.exit(1);
  }

  let live: string;
  try {
    live = await generateSnapshot();
  } catch (err) {
    console.error("Error fetching live RLS state:", (err as Error).message);
    process.exit(1);
  }

  const diffOutput = diff(committed.trimEnd(), live.trimEnd());

  if (!diffOutput) {
    console.log("RLS snapshot matches committed baseline. No drift detected.");
    process.exit(0);
  }

  console.error(
    "RLS DRIFT DETECTED — live RLS policies differ from db/rls-snapshot.sql\n" +
      "Lines prefixed with '-' are in the committed snapshot but not live.\n" +
      "Lines prefixed with '+' are live but not in the committed snapshot.\n\n" +
      "To update the baseline: npx tsx scripts/rls-snapshot.ts > db/rls-snapshot.sql\n" +
      "Commit db/rls-snapshot.sql alongside the migration that caused the change.\n\n" +
      diffOutput,
  );
  process.exit(1);
}

main();
