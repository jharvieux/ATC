/**
 * BP30 Phase B self-tests for the fixture loader.
 *
 * The loader CLI itself runs against a real Postgres in CI when
 * SUPABASE_DB_URL is set. These self-tests cover the pure helpers
 * (EXPECTED_COUNTS parser, fixture file enumeration, sidecar detection)
 * against synthetic input so the parser logic stays honest as the file
 * format evolves.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExpectedCounts,
  enumerateFixtureFiles,
} from "../../scripts/load-fixtures";

describe("parseExpectedCounts", () => {
  it("parses plain `table: N` entries inside a fenced block", () => {
    const raw = "```\ntenants: 5\nlegal_documents: 8\n```";
    const result = parseExpectedCounts(raw);
    expect(result).toEqual([
      { table: "tenants", expected: 5, todo: false },
      { table: "legal_documents", expected: 8, todo: false },
    ]);
  });

  it("marks `(TODO ...)` entries as todo", () => {
    const raw = "```\nbookings: 0 (TODO populate)\n```";
    const result = parseExpectedCounts(raw);
    expect(result).toEqual([{ table: "bookings", expected: 0, todo: true }]);
  });

  it("tolerates a trailing # comment", () => {
    const raw = "```\nrag_chunks: 0 (TODO)             # in the RAG project\n```";
    const result = parseExpectedCounts(raw);
    expect(result).toEqual([{ table: "rag_chunks", expected: 0, todo: true }]);
  });

  it("ignores markdown prose between code fences", () => {
    const raw = [
      "# Heading",
      "",
      "Some prose explaining the format.",
      "",
      "```",
      "tenants: 5",
      "```",
      "",
      "More prose.",
      "",
      "```",
      "legal_documents: 8",
      "```",
    ].join("\n");
    const result = parseExpectedCounts(raw);
    expect(result.length).toBe(2);
    expect(result.map((e) => e.table).sort()).toEqual(["legal_documents", "tenants"]);
  });

  it("rejects duplicate table entries", () => {
    const raw = "```\ntenants: 5\ntenants: 6\n```";
    expect(() => parseExpectedCounts(raw)).toThrow(/duplicate entry for table 'tenants'/);
  });

  it("throws when no parseable entries are present", () => {
    const raw = "# Heading\n\nJust prose, no entries.";
    expect(() => parseExpectedCounts(raw)).toThrow(/no parseable/i);
  });

  it("ignores blank lines and `-` bullet markers", () => {
    const raw = [
      "```",
      "",
      "- not an entry",
      "tenants: 5",
      "",
      "```",
    ].join("\n");
    const result = parseExpectedCounts(raw);
    expect(result).toEqual([{ table: "tenants", expected: 5, todo: false }]);
  });
});

describe("enumerateFixtureFiles", () => {
  it("returns *.sql files in lexicographic order from a directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fixtures-enum-"));
    try {
      writeFileSync(join(tmp, "02_bookings.sql"), "");
      writeFileSync(join(tmp, "00_tenants.sql"), "");
      writeFileSync(join(tmp, "01_users.sql"), "");
      writeFileSync(join(tmp, "README.md"), "should be ignored");
      writeFileSync(join(tmp, "EXPECTED_COUNTS.md"), "should be ignored");
      const files = enumerateFixtureFiles(tmp);
      expect(files.map((f) => f.split("/").pop())).toEqual([
        "00_tenants.sql",
        "01_users.sql",
        "02_bookings.sql",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an empty array when the directory has no SQL files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fixtures-empty-"));
    try {
      writeFileSync(join(tmp, "README.md"), "");
      expect(enumerateFixtureFiles(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("real EXPECTED_COUNTS.md parses cleanly", () => {
  it("the committed file parses without error and includes the seed tables", () => {
    const path = join(__dirname, "..", "..", "test-data", "fixtures", "EXPECTED_COUNTS.md");
    const raw = require("node:fs").readFileSync(path, "utf8");
    const result = parseExpectedCounts(raw);
    const tables = result.map((r) => r.table);
    expect(tables).toContain("tier_definitions");
    expect(tables).toContain("tenants");
    expect(tables).toContain("legal_documents");
    // Spot-check a known-TODO entry.
    const bookings = result.find((r) => r.table === "bookings");
    expect(bookings?.todo).toBe(true);
  });
});

describe("real fixture directory enumerates the BP30 §30.4 set", () => {
  it("contains the 10 spec-named fixture files plus EXPECTED_COUNTS.md", () => {
    const dir = join(__dirname, "..", "..", "test-data", "fixtures");
    const files = enumerateFixtureFiles(dir);
    const basenames = files.map((f) => f.split("/").pop()).sort();
    expect(basenames).toEqual([
      "00_tenants.sql",
      "01_users.sql",
      "02_contacts.sql",
      "03_bookings.sql",
      "04_commissions.sql",
      "05_quotes.sql",
      "06_rag_chunks.sql",
      "07_legal_documents.sql",
      "08_groups_invitations.sql",
      "09_forum_messages.sql",
    ]);
  });
});
