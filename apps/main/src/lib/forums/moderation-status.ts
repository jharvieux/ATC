// §19.3 — Forum moderation score → status decision.
//
// Single source of the moderation thresholds, shared by the message-post
// route, the retry job, and their unit test (D-091 / #384 — no in-test
// reimplementation). max_score is the highest of the per-category scores
// returned by the Haiku classifier.
//   < 0.4       → visible
//   0.4 – 0.7   → flagged_review (human review queue)
//   > 0.7       → hidden (auto-strike)
export function decideModerationStatus(
  maxScore: number,
): "visible" | "flagged_review" | "hidden" {
  if (maxScore < 0.4) return "visible";
  if (maxScore <= 0.7) return "flagged_review";
  return "hidden";
}
