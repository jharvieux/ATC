// #1271 — unit tests for the AI-purpose constraint guard.
//
// Pins the three outcomes that matter:
// 1. Union and constraint match → passes.
// 2. Union has a member the constraint doesn't → fails (insert would throw).
// 3. Constraint has a value not in the union → fails (dead allow-list entry).

import { describe, it, expect } from "vitest";
import {
  parseAICallPurposeUnion,
  parseConstraintValues,
} from "../../../scripts/check-ai-purpose-constraint";

const UNION_SRC = `
export type AICallPurpose =
  | "chat_main"
  | "chat_supervisor"
  | "embedding"
  // a comment that must not confuse the parser
  | "other";
`;

const CONSTRAINT_SQL = `
ALTER TABLE public.ai_call_log
  DROP CONSTRAINT IF EXISTS ai_call_log_purpose_check;

ALTER TABLE public.ai_call_log
  ADD CONSTRAINT ai_call_log_purpose_check CHECK (purpose IN (
    'chat_main','chat_supervisor',
    'embedding','other'
  ));
`;

describe("parseAICallPurposeUnion", () => {
  it("extracts all string-literal union members", () => {
    expect(parseAICallPurposeUnion(UNION_SRC)).toEqual(
      new Set(["chat_main", "chat_supervisor", "embedding", "other"]),
    );
  });

  it("returns empty set when AICallPurpose type is absent", () => {
    expect(parseAICallPurposeUnion("const x = 42;")).toEqual(new Set());
  });

  it("ignores comments with mid-line semicolons", () => {
    const src = `
export type AICallPurpose =
  | "a"
  // §38 — some note (TA-facing; same posture as other)
  | "b";
`;
    expect(parseAICallPurposeUnion(src)).toEqual(new Set(["a", "b"]));
  });

  it("does not stop early when a comment line ends with a quoted semicolon", () => {
    const src = `
export type AICallPurpose =
  | "a"
  // matches the "foo"; pattern
  | "b";
`;
    expect(parseAICallPurposeUnion(src)).toEqual(new Set(["a", "b"]));
  });
});

describe("parseConstraintValues", () => {
  it("extracts all single-quoted values from the CHECK constraint", () => {
    expect(parseConstraintValues(CONSTRAINT_SQL)).toEqual(
      new Set(["chat_main", "chat_supervisor", "embedding", "other"]),
    );
  });

  it("returns empty set when constraint is absent from the SQL", () => {
    expect(parseConstraintValues("CREATE TABLE foo (id uuid);")).toEqual(
      new Set(),
    );
  });

  it("handles values on a single line", () => {
    const sql = `ADD CONSTRAINT ai_call_log_purpose_check CHECK (purpose IN ('a','b','c'))`;
    expect(parseConstraintValues(sql)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("in-sync / drift detection (integration of both parsers)", () => {
  it("in-sync: both sets match", () => {
    const union = parseAICallPurposeUnion(UNION_SRC);
    const constraint = parseConstraintValues(CONSTRAINT_SQL);
    const extraInUnion = [...union].filter((v) => !constraint.has(v));
    const extraInConstraint = [...constraint].filter((v) => !union.has(v));
    expect(extraInUnion).toEqual([]);
    expect(extraInConstraint).toEqual([]);
  });

  it("union-has-extra: new purpose not yet in constraint", () => {
    const src = UNION_SRC.replace('| "other";', '| "other"\n  | "new_purpose";');
    const union = parseAICallPurposeUnion(src);
    const constraint = parseConstraintValues(CONSTRAINT_SQL);
    const extraInUnion = [...union].filter((v) => !constraint.has(v));
    expect(extraInUnion).toEqual(["new_purpose"]);
  });

  it("constraint-has-extra: orphaned value left in constraint after union removal", () => {
    const sql = CONSTRAINT_SQL.replace("'other'", "'other','orphaned_old'");
    const union = parseAICallPurposeUnion(UNION_SRC);
    const constraint = parseConstraintValues(sql);
    const extraInConstraint = [...constraint].filter((v) => !union.has(v));
    expect(extraInConstraint).toEqual(["orphaned_old"]);
  });
});
