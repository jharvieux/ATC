export const TONE_LABELS = [
  "Formal",
  "Professional",
  "Friendly",
  "Casual",
  "Very Casual",
] as const;

export type ToneLabel = (typeof TONE_LABELS)[number];

export const TONE_LABEL_TO_LEVEL: Record<ToneLabel, number> = {
  Formal: 1,
  Professional: 2,
  Friendly: 3,
  Casual: 4,
  "Very Casual": 5,
};

/** Convert a numeric tone level (1–5) to its label. Out-of-range values clamp to "Friendly". */
export function toneLevelToLabel(level: number): ToneLabel {
  return TONE_LABELS[level - 1] ?? "Friendly";
}

/** Convert a tone label to its numeric level (1–5). */
export function toneLabelToLevel(label: ToneLabel): number {
  return TONE_LABEL_TO_LEVEL[label];
}
