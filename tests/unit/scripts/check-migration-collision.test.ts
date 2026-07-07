// Unit tests for the migration-version collision gate (#1660/#1661).
//
// Intent encoded here: the guard must catch (1) two files sharing a version
// in the same app's migrations dir, and (2) a branch-added migration whose
// version already exists on the base ref under a different filename — the
// exact #1660 incident (N parallel agents deriving the same "next" version).
// It must NOT fire on a migration that's merely modified (not added), on
// distinct versions, or on a baselined pre-existing pair — otherwise authors
// learn to ignore it.

import { describe, it, expect } from "vitest";
import {
  parseVersion,
  findDuplicatesInApp,
  findBranchVsDevCollisions,
  readBaseline,
} from "../../../scripts/check-migration-collision";

describe("parseVersion", () => {
  it("extracts the 14-digit main-style version", () => {
    expect(parseVersion("20260719000000_invitations_dedup.sql")).toBe("20260719000000");
  });

  it("extracts the 4-digit rag-style version", () => {
    expect(parseVersion("0033_region_itinerary_segment_match.sql")).toBe("0033");
  });

  it("returns null for a non-conforming filename", () => {
    expect(parseVersion("not_a_migration.sql")).toBeNull();
    expect(parseVersion("README.md")).toBeNull();
  });
});

describe("findDuplicatesInApp", () => {
  it("flags two files sharing a version", () => {
    const v = findDuplicatesInApp("rag", [
      "0014_composite_weights.sql",
      "0014_platform_settings_sync.sql",
      "0015_next.sql",
    ]);
    expect(v).toEqual([
      {
        kind: "duplicate-in-app",
        app: "rag",
        version: "0014",
        files: ["0014_composite_weights.sql", "0014_platform_settings_sync.sql"],
      },
    ]);
  });

  it("does NOT fire when all versions are distinct", () => {
    const v = findDuplicatesInApp("main", [
      "20260719000000_a.sql",
      "20260719000001_b.sql",
    ]);
    expect(v).toEqual([]);
  });

  it("ignores files that don't parse as migrations", () => {
    const v = findDuplicatesInApp("main", ["20260719000000_a.sql", "README.md"]);
    expect(v).toEqual([]);
  });
});

describe("findBranchVsDevCollisions", () => {
  it("flags a branch-added file whose version already exists on dev under a different name", () => {
    const v = findBranchVsDevCollisions(
      "main",
      ["20260719000000_new_thing.sql"],
      ["20260719000000_invitations_active_email_dedup.sql"],
    );
    expect(v).toEqual([
      {
        kind: "branch-vs-dev",
        app: "main",
        version: "20260719000000",
        branchFile: "20260719000000_new_thing.sql",
        devFile: "20260719000000_invitations_active_email_dedup.sql",
      },
    ]);
  });

  it("does NOT fire when the branch file IS the dev file (unmodified, re-added in a diff quirk)", () => {
    const v = findBranchVsDevCollisions(
      "main",
      ["20260719000000_invitations_active_email_dedup.sql"],
      ["20260719000000_invitations_active_email_dedup.sql"],
    );
    expect(v).toEqual([]);
  });

  it("does NOT fire when the branch's version doesn't exist on dev at all", () => {
    const v = findBranchVsDevCollisions(
      "main",
      ["20260722000000_new_thing.sql"],
      ["20260719000000_invitations_active_email_dedup.sql"],
    );
    expect(v).toEqual([]);
  });
});

describe("readBaseline", () => {
  it("parses app:version:files keys, ignoring comments and blank lines", () => {
    const text = [
      "# a comment",
      "",
      "rag:0014:0014_composite_weights.sql,0014_platform_settings_sync.sql # PRs #105/#108",
    ].join("\n");
    const baseline = readBaseline(text);
    expect(baseline.has("rag:0014:0014_composite_weights.sql,0014_platform_settings_sync.sql")).toBe(
      true,
    );
    expect(baseline.size).toBe(1);
  });

  it("returns an empty set for empty input", () => {
    expect(readBaseline("").size).toBe(0);
  });
});
