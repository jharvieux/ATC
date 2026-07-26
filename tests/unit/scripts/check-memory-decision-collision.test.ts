// Unit tests for the MEMORY.md decision-number collision gate (#1661).
//
// The git/fs edges (readFileAt, addedMemoryHeaders, fs.readFileSync in main)
// are not exported; the pure core (extractMemoryHeaders, extractIndexEntries,
// findDuplicateAdds, findIndexMismatch) is tested directly.
//
// Intent: a PR must be flagged when it adds a `## D-NNN` header that a
// sibling PR already merged under the same number (the #1652/#1643 D-318
// incident) — but NOT when it merely carries forward pre-existing entries
// unchanged. Separately, MEMORY.md and MEMORY-INDEX.md's header sets must
// match exactly; a one-sided update is a half-done renumber, which is
// exactly how a duplicate slips through undetected.

import { describe, it, expect } from "vitest";
import {
  extractMemoryHeaders,
  extractIndexEntries,
  findDuplicateAdds,
  findIndexMismatch,
  findIndexOverlap,
} from "../../../scripts/check-memory-decision-collision";

describe("extractMemoryHeaders", () => {
  it("extracts ## D-NNN headers from MEMORY.md-shaped text", () => {
    const text = "## D-319 — 2026-07-07 — Title\n\nbody\n\n---\n\n## D-318 — 2026-07-06 — Other\n";
    expect(extractMemoryHeaders(text)).toEqual(["D-319", "D-318"]);
  });

  it("ignores non-header lines mentioning D-NNN", () => {
    const text = "See [[D-318]] for context.\n## D-320 — today — Real header\n";
    expect(extractMemoryHeaders(text)).toEqual(["D-320"]);
  });
});

describe("extractIndexEntries", () => {
  it("extracts - D-NNN entries from MEMORY-INDEX.md-shaped text", () => {
    const text = "## Entries\n\n- D-319 — 2026-07-07 — Title\n- D-318 — 2026-07-06 — Other\n";
    expect(extractIndexEntries(text)).toEqual(["D-319", "D-318"]);
  });
});

describe("findDuplicateAdds", () => {
  it("flags a D-number the branch adds that already exists on base", () => {
    const baseHeaders = ["D-318", "D-317", "D-316"];
    const addedHeaders = ["D-318"]; // this branch's diff adds a NEW D-318 line
    expect(findDuplicateAdds(baseHeaders, addedHeaders)).toEqual(["D-318"]);
  });

  it("does NOT fire when the branch adds a genuinely new number", () => {
    const baseHeaders = ["D-318", "D-317"];
    const addedHeaders = ["D-319"];
    expect(findDuplicateAdds(baseHeaders, addedHeaders)).toEqual([]);
  });

  it("does NOT fire when nothing was added (docs-only or unrelated diff)", () => {
    expect(findDuplicateAdds(["D-318", "D-317"], [])).toEqual([]);
  });

  it("de-duplicates repeated matches", () => {
    expect(findDuplicateAdds(["D-318"], ["D-318", "D-318"])).toEqual(["D-318"]);
  });
});

describe("findIndexMismatch", () => {
  it("returns empty arrays when both sets match", () => {
    const headers = ["D-319", "D-318"];
    const entries = ["D-319", "D-318"];
    expect(findIndexMismatch(headers, entries)).toEqual({ onlyInMemory: [], onlyInIndex: [] });
  });

  it("flags a header present in MEMORY.md but missing from the index", () => {
    const headers = ["D-319", "D-318"];
    const entries = ["D-318"];
    expect(findIndexMismatch(headers, entries)).toEqual({ onlyInMemory: ["D-319"], onlyInIndex: [] });
  });

  it("flags an entry present in the index but missing from MEMORY.md", () => {
    const headers = ["D-318"];
    const entries = ["D-319", "D-318"];
    expect(findIndexMismatch(headers, entries)).toEqual({ onlyInMemory: [], onlyInIndex: ["D-319"] });
  });

  // The D-366 split: the caller passes the UNION of lean-index + archive
  // entries; a number carried by either file satisfies the mirror.
  it("accepts headers split across index and archive when the caller unions them", () => {
    const headers = ["D-319", "D-100"];
    const union = [...["D-319"], ...["D-100"]]; // index + archive
    expect(findIndexMismatch(headers, union)).toEqual({ onlyInMemory: [], onlyInIndex: [] });
  });
});

describe("findIndexOverlap", () => {
  it("returns empty when index and archive are disjoint", () => {
    expect(findIndexOverlap(["D-319", "D-318"], ["D-100", "D-099"])).toEqual([]);
  });

  it("flags a D-number present in both files (half-done archive move)", () => {
    expect(findIndexOverlap(["D-319", "D-100"], ["D-100", "D-099"])).toEqual(["D-100"]);
  });

  it("de-duplicates repeated index entries in the overlap result", () => {
    expect(findIndexOverlap(["D-100", "D-100"], ["D-100"])).toEqual(["D-100"]);
  });
});
