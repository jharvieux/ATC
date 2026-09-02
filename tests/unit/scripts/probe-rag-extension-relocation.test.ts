import { describe, expect, it } from "vitest";
import {
  assertExpectedTarget,
  canonicalJson,
  digestLedgerRows,
  snapshotsEqual,
} from "../../../scripts/probe-rag-extension-relocation";

const TEST_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";

describe("RAG extension relocation probe target guard", () => {
  it("rejects any project other than the exact operator-authorized ref", () => {
    expect(() =>
      assertExpectedTarget(
        `postgres://postgres:secret@db.${OTHER_REF}.supabase.co/postgres`,
        TEST_REF,
      ),
    ).toThrow("does not match the explicitly authorized project ref");
  });

  it("accepts direct and pooler URLs only when their Supabase project ref is provable", () => {
    expect(
      assertExpectedTarget(
        `postgres://postgres:secret@db.${TEST_REF}.supabase.co/postgres`,
        TEST_REF,
      ).projectRef,
    ).toBe("abcd…qrst");
    expect(
      assertExpectedTarget(
        `postgres://postgres.${TEST_REF}:secret@aws-0-us-east-1.pooler.supabase.com/postgres`,
        TEST_REF,
      ).projectRef,
    ).toBe("abcd…qrst");
    expect(() =>
      assertExpectedTarget("postgres://postgres:secret@localhost/postgres", TEST_REF),
    ).toThrow("Could not prove the Supabase project ref");
  });
});

describe("RAG extension relocation probe rollback evidence", () => {
  const base = {
    identity: [{ current_user: "postgres", session_user: "postgres" }],
    memberships: [{ member: "postgres", granted_role: "supabase_admin" }],
    extensions: [
      { extension: "pg_trgm", schema: "extensions" },
      { extension: "vector", schema: "extensions" },
    ],
    schemas: [{ schema: "public" }, { schema: "extensions" }],
    migrationLedger: { count: 2, digest: "digest" },
  };

  it("requires every captured before/after value to be identical", () => {
    expect(snapshotsEqual(base, structuredClone(base))).toBe(true);
    expect(
      snapshotsEqual(base, {
        ...structuredClone(base),
        extensions: [
          { extension: "pg_trgm", schema: "extensions" },
          { extension: "vector", schema: "public" },
        ],
      }),
    ).toBe(false);
  });

  it("computes a stable ledger digest independent of row and object-key order", () => {
    const left = [{ version: "2", name: "b" }, { version: "1", name: "a" }];
    const right = [{ name: "a", version: "1" }, { name: "b", version: "2" }];
    expect(digestLedgerRows(left)).toBe(digestLedgerRows(right));
    expect(digestLedgerRows(left)).not.toBe(digestLedgerRows([...right, { version: "3" }]));
  });

  it("canonicalizes nested metadata for exact equality receipts", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
  });
});
