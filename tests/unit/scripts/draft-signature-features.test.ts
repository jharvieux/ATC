// #1565 — unit tests for the offline, deterministic SQL-emission path of the
// signature_feature drafting script. draftOne/main require a live Anthropic
// call and are exercised manually via --sql-only; these tests pin the parts
// that run with no API access:
//   - sqlEscape: single quotes must be doubled or the emitted UPDATE breaks.
//   - writeApplySql: every UPDATE carries the `signature_feature IS NULL`
//     idempotency guard (never clobbers an operator-set value), and drafts
//     the model declined (signature_feature: null) are omitted entirely.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqlEscape, writeApplySql, type DraftLine } from "../../../scripts/draft-signature-features";

const draft = (over: Partial<DraftLine>): DraftLine => ({
  ship: "Test Ship",
  signature_feature: "Go-kart track",
  rationale: "distinctive deck feature",
  source_excerpt: "deck 18: go-kart track",
  cost_usd: 0.0001,
  ts: "2026-07-13T00:00:00.000Z",
  ...over,
});

describe("sqlEscape", () => {
  it("doubles single quotes so the emitted SQL string literal stays valid", () => {
    expect(sqlEscape("Ship's Landing")).toBe("Ship''s Landing");
  });

  it("leaves strings without quotes unchanged", () => {
    expect(sqlEscape("Go-kart track")).toBe("Go-kart track");
  });
});

describe("writeApplySql", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("guards every emitted UPDATE with signature_feature IS NULL — never clobbers an operator-set value", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-sql-test-"));
    const sqlPath = path.join(tmpDir, "apply.sql");
    writeApplySql([draft({})], sqlPath);
    const sql = fs.readFileSync(sqlPath, "utf8");
    expect(sql).toContain("AND signature_feature IS NULL");
  });

  it("escapes single quotes in both the feature value and the ship name", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-sql-test-"));
    const sqlPath = path.join(tmpDir, "apply.sql");
    writeApplySql(
      [draft({ ship: "Ship's Landing", signature_feature: "Kids' waterpark" })],
      sqlPath,
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    expect(sql).toContain("Ship''s Landing");
    expect(sql).toContain("Kids'' waterpark");
    // the raw unescaped apostrophe form must not appear (would break the UPDATE)
    expect(sql).not.toContain("Ship's Landing");
    expect(sql).not.toContain("Kids' waterpark");
  });

  it("omits ships the model declined (signature_feature: null) — no UPDATE emitted", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sig-sql-test-"));
    const sqlPath = path.join(tmpDir, "apply.sql");
    writeApplySql(
      [
        draft({ ship: "Declined Ship", signature_feature: null }),
        draft({ ship: "Accepted Ship", signature_feature: "Ultimate Abyss slide" }),
      ],
      sqlPath,
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    expect(sql).not.toContain("Declined Ship");
    expect(sql).toContain("Accepted Ship");
    expect(sql.match(/UPDATE public\.cruise_ships/g)).toHaveLength(1);
  });
});
