// BP34 §34.2.2 — Import-trigger detection tests.
//
// Per spec: word-boundary check; "IMPORT" only matches as a standalone
// word at the start of subject or first non-empty body line. The build
// prompt explicitly enumerates the negatives (IMPORTANT, IMPORTED,
// IMPORTING, "imported their file") — a regression on those would
// silently re-trigger import parsing on regular customer email.

import { describe, expect, it } from "vitest";
import { qualifiesForImport } from "../../../src/lib/import/trigger-regex";

describe("qualifiesForImport — positives (subject)", () => {
  for (const subject of [
    "IMPORT",
    "Import",
    "import",
    "IMPORT:",
    "Import:",
    "IMPORT -",
    "IMPORT - lead from Maria",
    "  IMPORT lead from web form",
    "import - John Smith referral",
  ]) {
    it(`subject ${JSON.stringify(subject)} → matches`, () => {
      expect(qualifiesForImport(subject, "")).toBe(true);
    });
  }
});

describe("qualifiesForImport — positives (body first line)", () => {
  for (const body of [
    "IMPORT",
    "IMPORT\nrest of body",
    "IMPORT - forwarded message follows\n\nfrom: client@example.com",
    "\n\nIMPORT\n\n(blank lines before)",
    "  Import: see attached statement",
    "import\nforwarded message",
  ]) {
    it(`body ${JSON.stringify(body.slice(0, 30))}... → matches`, () => {
      expect(qualifiesForImport("Fwd: client inquiry", body)).toBe(true);
    });
  }
});

describe("qualifiesForImport — negatives (word-boundary guards)", () => {
  for (const subject of [
    "IMPORTANT",
    "IMPORTANT: please read",
    "IMPORTED leads from spreadsheet",
    "IMPORTING contacts",
    "important client question",
    "Re: IMPORTANT",
  ]) {
    it(`subject ${JSON.stringify(subject)} → does NOT match`, () => {
      expect(qualifiesForImport(subject, "")).toBe(false);
    });
  }

  for (const body of [
    "IMPORTANT — please read",
    "I IMPORTED their lead list",
    "importing client data",
    "The agent imported their file last week",
  ]) {
    it(`body ${JSON.stringify(body.slice(0, 30))}... → does NOT match`, () => {
      expect(qualifiesForImport("Customer follow-up", body)).toBe(false);
    });
  }
});

describe("qualifiesForImport — empty / whitespace inputs", () => {
  it("empty subject + empty body → no match", () => {
    expect(qualifiesForImport("", "")).toBe(false);
  });

  it("body that's only blank lines → no match", () => {
    expect(qualifiesForImport("Re: hi", "\n\n   \n\n")).toBe(false);
  });

  it("IMPORT appearing mid-body (not first non-empty line) → no match", () => {
    expect(
      qualifiesForImport("client question", "Hi,\n\nPlease IMPORT this for me.\n\nThanks"),
    ).toBe(false);
  });
});
