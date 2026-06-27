// Unit tests for the policy-migration ↔ RLS-snapshot consistency gate (#1492).
//
// The git/IO edges (changedFiles, fs.readFileSync) are not exported; the core
// `analyze` decision and the `stripSqlComments` helper are tested directly with
// a fake changed-file set and an in-memory file reader.
//
// Intent encoded here: a migration that changes RLS policies WITHOUT its
// snapshot regenerated in the same diff must be flagged — that is exactly the
// #1486 drift this guard exists to prevent. Conversely, the guard must NOT fire
// on index/data migrations, on a policy keyword buried in a comment, or when the
// snapshot IS updated — otherwise it becomes noise the author learns to ignore.

import { describe, it, expect } from "vitest";
import { analyze, stripSqlComments } from "../../../scripts/check-policy-snapshot";

const POLICY_MIG = "apps/main/supabase/migrations/20260715000000_x.sql";
const RAG_MIG = "apps/rag/supabase/migrations/20260715000000_x.sql";
const MAIN_SNAP = "db/rls-snapshot-main.sql";
const RAG_SNAP = "db/rls-snapshot-rag.sql";

// Build an in-memory reader from a path→content map.
const reader = (files: Record<string, string>) => (p: string) => {
  if (!(p in files)) throw new Error(`no such file: ${p}`);
  return files[p]!;
};

const CREATE_POLICY = `CREATE POLICY "x_select" ON public.x FOR SELECT TO PUBLIC USING (true);`;

describe("analyze", () => {
  it("flags a policy migration when the main snapshot is NOT in the diff", () => {
    const v = analyze([POLICY_MIG], reader({ [POLICY_MIG]: CREATE_POLICY }));
    expect(v).toEqual([{ migration: POLICY_MIG, app: "main", snapshot: MAIN_SNAP }]);
  });

  it("passes when the matching snapshot IS in the diff", () => {
    const v = analyze(
      [POLICY_MIG, MAIN_SNAP],
      reader({ [POLICY_MIG]: CREATE_POLICY, [MAIN_SNAP]: "..." }),
    );
    expect(v).toEqual([]);
  });

  it("requires the RAG snapshot for a rag migration (not the main one)", () => {
    const withMain = analyze(
      [RAG_MIG, MAIN_SNAP],
      reader({ [RAG_MIG]: CREATE_POLICY, [MAIN_SNAP]: "..." }),
    );
    expect(withMain).toEqual([{ migration: RAG_MIG, app: "rag", snapshot: RAG_SNAP }]);

    const withRag = analyze(
      [RAG_MIG, RAG_SNAP],
      reader({ [RAG_MIG]: CREATE_POLICY, [RAG_SNAP]: "..." }),
    );
    expect(withRag).toEqual([]);
  });

  it("flags ALTER POLICY and DROP POLICY, not just CREATE", () => {
    for (const ddl of [
      `ALTER POLICY "x" ON public.x TO authenticated;`,
      `DROP POLICY IF EXISTS "x" ON public.x;`,
    ]) {
      expect(analyze([POLICY_MIG], reader({ [POLICY_MIG]: ddl }))).toHaveLength(1);
    }
  });

  it("does NOT fire on a non-policy migration (e.g. CREATE INDEX)", () => {
    const idx = `CREATE INDEX IF NOT EXISTS x_y_idx ON public.x (y);`;
    expect(analyze([POLICY_MIG], reader({ [POLICY_MIG]: idx }))).toEqual([]);
  });

  it("does NOT fire when the policy keyword only appears inside a comment", () => {
    const sql = `-- this migration does not CREATE POLICY anything\nCREATE INDEX x_y_idx ON public.x (y);`;
    expect(analyze([POLICY_MIG], reader({ [POLICY_MIG]: sql }))).toEqual([]);
  });

  it("honors the -- snapshot-guard-allow:<reason> suppression", () => {
    const sql = `-- snapshot-guard-allow: DROP+identical CREATE, no snapshot delta\n${CREATE_POLICY}`;
    expect(analyze([POLICY_MIG], reader({ [POLICY_MIG]: sql }))).toEqual([]);
  });

  it("ignores non-migration files in the diff", () => {
    const src = "apps/main/src/app/api/x/route.ts";
    expect(analyze([src], reader({ [src]: CREATE_POLICY }))).toEqual([]);
  });
});

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    expect(stripSqlComments("a -- CREATE POLICY x\nb")).not.toMatch(/POLICY/);
    expect(stripSqlComments("a /* CREATE POLICY x */ b")).not.toMatch(/POLICY/);
  });

  it("leaves real DDL intact", () => {
    expect(stripSqlComments(`CREATE POLICY "p" ON t;`)).toMatch(/CREATE POLICY/);
  });
});
