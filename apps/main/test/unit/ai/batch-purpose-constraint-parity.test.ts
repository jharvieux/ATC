// #1695 — pin the ai_batch_jobs / ai_batch_requests purpose CHECK constraints
// to the BatchablePurpose union.
//
// WHY this test exists (intent, not behavior): the enqueue/flush pipeline
// accepts any BatchablePurpose, but the value must ALSO be in the DB CHECK or
// the INSERT dies with a 23514 and the whole purpose is silently broken
// end-to-end (that was #1695 for persona_addendum_rescreen). TypeScript can't
// see the SQL constraint, so nothing catches the drift until production. This
// test reads the live CHECK list straight out of the latest migration that
// defines each constraint and asserts it equals BATCHABLE_PURPOSES — so the
// next time someone adds a purpose to the union without widening the CHECK,
// CI fails here instead of the nightly cron failing in prod.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BATCHABLE_PURPOSES } from "@/lib/ai/batch/types";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

/**
 * Return the purpose values from the LATEST migration (filename-sorted, which
 * is timestamp order) that defines an `ADD CONSTRAINT <constraint> CHECK
 * (purpose IN (...))`. The latest writer is the effective constraint on the DB.
 */
function latestCheckList(constraintName: string): string[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const re = new RegExp(
    `ADD\\s+CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\(\\s*purpose\\s+IN\\s*\\(([^)]*)\\)`,
    "i",
  );

  for (const file of [...files].reverse()) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const m = re.exec(sql);
    if (m && m[1]) {
      return m[1]
        .split(",")
        .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""))
        .filter((s) => s.length > 0);
    }
  }
  throw new Error(`no migration defines ADD CONSTRAINT ${constraintName}`);
}

describe("ai_batch purpose CHECK constraint parity (#1695)", () => {
  const union = [...BATCHABLE_PURPOSES].sort();

  it("ai_batch_requests_purpose_check matches the BatchablePurpose union exactly", () => {
    expect(latestCheckList("ai_batch_requests_purpose_check").sort()).toEqual(union);
  });

  it("ai_batch_jobs_purpose_check matches the BatchablePurpose union exactly", () => {
    expect(latestCheckList("ai_batch_jobs_purpose_check").sort()).toEqual(union);
  });

  it("includes persona_addendum_rescreen — the value that was missing in #1695", () => {
    expect(latestCheckList("ai_batch_requests_purpose_check")).toContain(
      "persona_addendum_rescreen",
    );
    expect(latestCheckList("ai_batch_jobs_purpose_check")).toContain(
      "persona_addendum_rescreen",
    );
  });
});
