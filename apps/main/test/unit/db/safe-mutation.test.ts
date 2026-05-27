// D-094 — Safe-mutation wrapper unit tests.

import { describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import {
  SupabaseMutationError,
  safeAwait,
  safeAwaitRequired,
  safeAwaitRowCount,
  unwrap,
  unwrapRequired,
} from "../../../src/lib/db/safe-mutation";

const PG_ERROR = {
  message: "duplicate key value violates unique constraint",
  code: "23505",
  hint: "see pg_constraint",
  details: "Key (id)=(abc) already exists.",
  name: "PostgrestError",
} as unknown as PostgrestError;

describe("unwrap", () => {
  it("returns data on success", () => {
    expect(unwrap({ data: { id: "x" }, error: null }, "ctx")).toEqual({ id: "x" });
  });

  it("returns null when data is null and no error", () => {
    expect(unwrap({ data: null, error: null }, "ctx")).toBeNull();
  });

  it("throws SupabaseMutationError on error", () => {
    expect(() => unwrap({ data: null, error: PG_ERROR }, "tenants.update")).toThrow(SupabaseMutationError);
  });

  it("error message includes context + Postgres message", () => {
    try {
      unwrap({ data: null, error: PG_ERROR }, "tenants.update");
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseMutationError);
      const e = err as SupabaseMutationError;
      expect(e.message).toContain("tenants.update");
      expect(e.message).toContain("duplicate key");
      expect(e.code).toBe("23505");
      expect(e.context).toBe("tenants.update");
      expect(e.pgError).toBe(PG_ERROR);
    }
  });
});

describe("unwrapRequired", () => {
  it("returns data when non-null", () => {
    expect(unwrapRequired({ data: { id: "x" }, error: null }, "ctx")).toEqual({ id: "x" });
  });

  it("throws when data is null (even without error)", () => {
    expect(() => unwrapRequired({ data: null, error: null }, "ctx")).toThrow(SupabaseMutationError);
  });

  it("EMPTY_RESULT code is set when data is null", () => {
    try {
      unwrapRequired({ data: null, error: null }, "ctx");
    } catch (err) {
      expect((err as SupabaseMutationError).code).toBe("EMPTY_RESULT");
    }
  });

  it("throws normal error when error is truthy", () => {
    expect(() => unwrapRequired({ data: null, error: PG_ERROR }, "ctx")).toThrow(SupabaseMutationError);
  });
});

describe("safeAwait", () => {
  it("awaits then unwraps success", async () => {
    const query = Promise.resolve({ data: { id: "x" }, error: null });
    expect(await safeAwait(query, "ctx")).toEqual({ id: "x" });
  });

  it("awaits then throws on error", async () => {
    const query = Promise.resolve({ data: null, error: PG_ERROR });
    await expect(safeAwait(query, "ctx")).rejects.toBeInstanceOf(SupabaseMutationError);
  });

  it("returns null for void-result queries", async () => {
    const query = Promise.resolve({ data: null, error: null });
    expect(await safeAwait(query, "ctx")).toBeNull();
  });
});

describe("safeAwaitRequired", () => {
  it("returns data when non-null", async () => {
    const query = Promise.resolve({ data: { id: "x" }, error: null });
    expect(await safeAwaitRequired(query, "ctx")).toEqual({ id: "x" });
  });

  it("throws when data is null", async () => {
    const query = Promise.resolve({ data: null, error: null });
    await expect(safeAwaitRequired(query, "ctx")).rejects.toBeInstanceOf(SupabaseMutationError);
  });
});

describe("safeAwaitRowCount — CAS-style assertion", () => {
  it("returns the array when row count matches", async () => {
    const query = Promise.resolve({ data: [{ id: "a" }], error: null });
    expect(await safeAwaitRowCount(query, "ctx", 1)).toEqual([{ id: "a" }]);
  });

  it("throws ROW_COUNT_MISMATCH when 0 rows but 1 expected (the audit-bug case)", async () => {
    // Pre-fix payout CAS bug: zero-row update + error: null looked like success.
    // safeAwaitRowCount turns this into a structured throw.
    const query = Promise.resolve({ data: [] as Array<{ id: string }>, error: null });
    try {
      await safeAwaitRowCount(query, "payout_records.cas_lock", 1);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SupabaseMutationError);
      expect((err as SupabaseMutationError).code).toBe("ROW_COUNT_MISMATCH");
      expect((err as SupabaseMutationError).message).toContain("Expected 1 row(s); got 0");
    }
  });

  it("throws when actual > expected (concurrent insert race)", async () => {
    const query = Promise.resolve({ data: [{ id: "a" }, { id: "b" }], error: null });
    await expect(safeAwaitRowCount(query, "ctx", 1)).rejects.toBeInstanceOf(SupabaseMutationError);
  });

  it("handles null data as 0 rows", async () => {
    const query = Promise.resolve({ data: null, error: null });
    await expect(safeAwaitRowCount(query, "ctx", 1)).rejects.toBeInstanceOf(SupabaseMutationError);
  });

  it("propagates DB errors before checking count", async () => {
    const query = Promise.resolve({ data: null, error: PG_ERROR });
    try {
      await safeAwaitRowCount(query, "ctx", 1);
      throw new Error("should have thrown");
    } catch (err) {
      // Should be the original PG error, not ROW_COUNT_MISMATCH
      expect((err as SupabaseMutationError).code).toBe("23505");
    }
  });
});
