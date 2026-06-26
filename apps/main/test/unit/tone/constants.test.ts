import { describe, expect, it } from "vitest";
import {
  TONE_LABELS,
  TONE_LABEL_TO_LEVEL,
  toneLevelToLabel,
  toneLabelToLevel,
  type ToneLabel,
} from "@/lib/tone/constants";

describe("toneLevelToLabel", () => {
  it.each([
    [1, "Formal"],
    [2, "Professional"],
    [3, "Friendly"],
    [4, "Casual"],
    [5, "Very Casual"],
  ] as [number, ToneLabel][])(
    "level %i → %s",
    (level, expected) => {
      expect(toneLevelToLabel(level)).toBe(expected);
    },
  );

  it("clamps out-of-range low to Friendly", () => {
    expect(toneLevelToLabel(0)).toBe("Friendly");
  });

  it("clamps out-of-range high to Friendly", () => {
    expect(toneLevelToLabel(6)).toBe("Friendly");
  });

  it("clamps negative to Friendly", () => {
    expect(toneLevelToLabel(-1)).toBe("Friendly");
  });
});

describe("toneLabelToLevel", () => {
  it.each([
    ["Formal", 1],
    ["Professional", 2],
    ["Friendly", 3],
    ["Casual", 4],
    ["Very Casual", 5],
  ] as [ToneLabel, number][])(
    "%s → level %i",
    (label, expected) => {
      expect(toneLabelToLevel(label)).toBe(expected);
    },
  );
});

describe("round-trip", () => {
  it("toneLevelToLabel ∘ toneLabelToLevel is identity for all valid labels", () => {
    for (const label of TONE_LABELS) {
      expect(toneLevelToLabel(toneLabelToLevel(label))).toBe(label);
    }
  });

  it("toneLabelToLevel ∘ toneLevelToLabel is identity for levels 1–5", () => {
    for (let level = 1; level <= 5; level++) {
      expect(toneLabelToLevel(toneLevelToLabel(level))).toBe(level);
    }
  });

  it("TONE_LABELS and TONE_LABEL_TO_LEVEL are consistent", () => {
    // Every label at index i maps to level i+1, and the reverse map agrees.
    TONE_LABELS.forEach((label, i) => {
      expect(TONE_LABEL_TO_LEVEL[label]).toBe(i + 1);
    });
  });
});
