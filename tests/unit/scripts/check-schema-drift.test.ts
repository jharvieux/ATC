// Unit tests for the migration ledger ↔ live DB drift gate.
//
// Two exported functions are tested here — appliedVersions (DB call) is not
// exported because it always requires a live connection; the core logic it
// feeds into (computeDrift) is tested with plain arrays instead.
//
// Key invariants:
//   - UNAPPLIED: ledger has version, applied does not → drift.
//   - ORPHANED:  applied has version, ledger does not → drift.
//   - No drift:  both sets identical → ok.
//   - Empty ledger is an error (likely wrong cwd), not a silent skip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerVersions, computeDrift, checkTarget } from "../../../scripts/check-schema-drift";

// ─── ledgerVersions ──────────────────────────────────────────────────────────

describe("ledgerVersions", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("returns empty array when directory does not exist", () => {
    expect(ledgerVersions(path.join(tmpDir, "nonexistent"))).toEqual([]);
  });

  it("returns sorted bare version timestamps (no name suffix)", () => {
    fs.writeFileSync(path.join(tmpDir, "20240201120000_add_users.sql"), "");
    fs.writeFileSync(path.join(tmpDir, "20240101000000_initial.sql"), "");
    expect(ledgerVersions(tmpDir)).toEqual([
      "20240101000000",
      "20240201120000",
    ]);
  });

  it("ignores non-.sql files in the migrations directory", () => {
    fs.writeFileSync(path.join(tmpDir, "20240101_schema.sql"), "");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "");
    fs.writeFileSync(path.join(tmpDir, "seed.ts"), "");
    expect(ledgerVersions(tmpDir)).toHaveLength(1);
    expect(ledgerVersions(tmpDir)[0]).toBe("20240101");
  });

  it("returns empty array for an existing but empty directory", () => {
    expect(ledgerVersions(tmpDir)).toEqual([]);
  });
});

// ─── computeDrift ─────────────────────────────────────────────────────────────

describe("computeDrift", () => {
  it("returns no drift when ledger and applied are identical", () => {
    const ledger = ["20240101_init", "20240201_add_col"];
    expect(computeDrift(ledger, ledger)).toEqual({ unapplied: [], orphaned: [] });
  });

  it("detects UNAPPLIED when ledger has versions absent from DB", () => {
    const ledger = ["20240101_init", "20240201_add_col", "20240301_new_table"];
    const applied = ["20240101_init", "20240201_add_col"];
    const { unapplied, orphaned } = computeDrift(ledger, applied);
    expect(unapplied).toEqual(["20240301_new_table"]);
    expect(orphaned).toEqual([]);
  });

  it("detects ORPHANED when DB has versions absent from ledger", () => {
    const ledger = ["20240101_init"];
    const applied = ["20240101_init", "20240201_dashboard_hotfix"];
    const { unapplied, orphaned } = computeDrift(ledger, applied);
    expect(unapplied).toEqual([]);
    expect(orphaned).toEqual(["20240201_dashboard_hotfix"]);
  });

  it("detects both UNAPPLIED and ORPHANED simultaneously", () => {
    const ledger = ["20240101_init", "20240301_new"];
    const applied = ["20240101_init", "20240201_dashboard_hotfix"];
    const { unapplied, orphaned } = computeDrift(ledger, applied);
    expect(unapplied).toEqual(["20240301_new"]);
    expect(orphaned).toEqual(["20240201_dashboard_hotfix"]);
  });

  it("returns all applied as ORPHANED when ledger is empty", () => {
    // An empty ledger should already be caught upstream (checkTarget returns drift),
    // but the pure function handles it gracefully.
    const { unapplied, orphaned } = computeDrift([], ["20240101_init"]);
    expect(unapplied).toEqual([]);
    expect(orphaned).toEqual(["20240101_init"]);
  });

  it("returns all ledger entries as UNAPPLIED when applied is empty", () => {
    const { unapplied, orphaned } = computeDrift(["20240101_init"], []);
    expect(unapplied).toEqual(["20240101_init"]);
    expect(orphaned).toEqual([]);
  });

  it("handles multiple UNAPPLIED and multiple ORPHANED entries", () => {
    const ledger = ["v1", "v2", "v3", "v5"];
    const applied = ["v1", "v2", "v4", "v6"];
    const { unapplied, orphaned } = computeDrift(ledger, applied);
    expect(unapplied).toEqual(["v3", "v5"]);
    expect(orphaned).toEqual(["v4", "v6"]);
  });
});

// ─── checkTarget — empty-ledger gate ─────────────────────────────────────────
// The DB connection (appliedVersions) is only reached after the ledger check,
// so a fake dbUrl is safe here — the function returns before ever connecting.

describe("checkTarget — empty migrations directory is drift, not skip", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-ct-test-"));
    // Isolate from developer shell envs so URL-resolution is deterministic.
    vi.stubEnv("SUPABASE_DB_URL", "");
    vi.stubEnv("SUPABASE_RAG_DB_URL", "");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    vi.unstubAllEnvs();
  });

  it("returns drift when the migrations directory exists but contains no .sql files", async () => {
    const result = await checkTarget("main", "postgres://fake-url-never-reached", tmpDir);
    expect(result.status).toBe("drift");
    expect(result.message).toMatch(/no migration files found/);
  });

  it("returns drift when the migrations directory does not exist at all", async () => {
    const result = await checkTarget("rag", "postgres://fake-url-never-reached", path.join(tmpDir, "nonexistent"));
    expect(result.status).toBe("drift");
    expect(result.message).toMatch(/no migration files found/);
  });

  it("returns skipped (not drift) when no dbUrl is provided — env-var-missing is expected in local dev", async () => {
    const result = await checkTarget("main", null, tmpDir);
    expect(result.status).toBe("skipped");
  });
});
