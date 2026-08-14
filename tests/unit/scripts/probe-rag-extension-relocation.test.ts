import { describe, expect, it } from "vitest";
import {
  assertSafeTarget,
  canonicalJson,
  digestLedgerRows,
  snapshotsEqual,
} from "../../../scripts/probe-rag-extension-relocation";

const PRODUCTION_REF = "jjznkprbotkqqnuvcost";
const TEST_REF = "abcdefghijklmnopqrst";

describe("RAG extension relocation probe target guard", () => {
  it("rejects the production project before any database connection can be made", () => {
    expect(() =>
      assertSafeTarget(`postgres://postgres:secret@db.${PRODUCTION_REF}.supabase.co/postgres`),
    ).toThrow("Production RAG project rejected before connection");
  });

  it("accepts direct and pooler URLs only when their Supabase project ref is provable", () => {
    expect(
      assertSafeTarget(`postgres://postgres:secret@db.${TEST_REF}.supabase.co/postgres`).projectRef,
    ).toBe("abcd…qrst");
    expect(
      assertSafeTarget(
        `postgres://postgres.${TEST_REF}:secret@aws-0-us-east-1.pooler.supabase.com/postgres`,
      ).projectRef,
    ).toBe("abcd…qrst");
    expect(() => assertSafeTarget("postgres://postgres:secret@localhost/postgres")).toThrow(
      "Could not prove the Supabase project ref",
    );
  });
});

describe("RAG extension relocation probe rollback evidence", () => {
  const base = {
    identity: [{ current_user: "postgres", session_user: "postgres" }],
    memberships: [{ member: "postgres", granted_role: "supabase_admin" }],
    extensions: [
      { extension: "pg_trgm", schema: "public" },
      { extension: "vector", schema: "public" },
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
