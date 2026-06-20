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
