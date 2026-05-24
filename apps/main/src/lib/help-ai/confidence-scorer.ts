/**
 * BP31 §32.8 — Confidence/clarity scoring for bug reports.
 *
 * **THIS IS A STUB.** Per the BP31 Phase B cost-deferral decision
 * (MEMORY D-066), the Haiku-driven structured assessment from §32.8.2 is
 * deferred — every score returned here is the uniform fallback `0.5`
 * across all six factors. The TODO marker at the call site below is the
 * single place to wire the real Haiku call when an operator opts in.
 *
 * The scorer's CONTRACT is stable: callers persist the returned `score`
 * + `factors` shape to `bug_submissions.confidence_score` +
 * `bug_submissions.confidence_factors`. Wiring the real Haiku call later
 * only changes what numbers come out, not the schema or the API.
 *
 * §32.8.3 — score transparency: the score IS shown to tenant-admin
 * submitters before submission (so they can revise weak inputs). It is
 * NOT shown to customers (BP32 surface). The route handler decides the
 * UI gate; the scorer doesn't care.
 *
 * §32.8.4 — uniform weighting in v1: `score = mean(factors)`. Weighting
 * is a follow-on if uniform produces poor triage signal.
 */

import type { BugDraft } from "./flow-controller";

export interface ConfidenceFactors {
  specificity_of_location: number;
  clarity_of_actual_behavior: number;
  clarity_of_expected_behavior: number;
  completeness_of_steps: number;
  reproducibility_signal: number;
  environment_completeness: number;
}

export interface ConfidenceResult {
  score: number;            // 0..1, uniform mean of factors
  factors: ConfidenceFactors;
  rationale: string;        // short human-readable note; empty in the stub
  stubbed: true;            // explicit flag so downstream code can decide whether to show "TODO" badge
}

const STUB_FACTOR_VALUE = 0.5;

const STUB_FACTORS: ConfidenceFactors = Object.freeze({
  specificity_of_location: STUB_FACTOR_VALUE,
  clarity_of_actual_behavior: STUB_FACTOR_VALUE,
  clarity_of_expected_behavior: STUB_FACTOR_VALUE,
  completeness_of_steps: STUB_FACTOR_VALUE,
  reproducibility_signal: STUB_FACTOR_VALUE,
  environment_completeness: STUB_FACTOR_VALUE,
});

/**
 * Score a completed bug draft.
 *
 * **STUB:** returns uniform `0.5` across all six factors regardless of
 * draft content. Wire the Haiku call by replacing the body below with
 * a call to the Anthropic instrumented wrapper:
 *
 *   const text = `Given this bug report’s structured fields, return JSON
 *     { specificity_of_location, clarity_of_actual_behavior, ... }
 *     each as a number 0-1, plus a brief rationale per factor.`;
 *   const { text: response } = await instrumentedClaudeCall({
 *     tenant_id,
 *     model: 'claude-haiku-...',
 *     purpose: 'help_ai_supervisor',  // already in the BP31 purpose enum
 *     ...
 *   });
 *   const parsed = z.object({...}).parse(JSON.parse(response));
 *   return { score: mean(parsed.factors), factors: parsed.factors, rationale, stubbed: false };
 *
 * The stub purpose: the bug submission flow is wired end-to-end (gather
 * → score → summary → submit). Replacing the stub with the real call
 * happens later without changing the schema or call sites.
 */
export async function scoreBugDraft(
  _draft: BugDraft,
  _opts: { tenant_id: string },
): Promise<ConfidenceResult> {
  // TODO(help-ai-confidence-haiku): wire the §32.8.2 Haiku structured
  // assessment via instrumentedClaudeCall (purpose='help_ai_supervisor').
  // Operator opts in when willing to pay ~$0.001-0.005 per submission
  // for triage prioritization signal. Stub returns uniform 0.5 today
  // per MEMORY D-066.
  void _draft;
  void _opts;
  return {
    score: STUB_FACTOR_VALUE,
    factors: { ...STUB_FACTORS },
    rationale: "stub: uniform 0.5 (Haiku scorer deferred per BP31 Phase B cost decision)",
    stubbed: true,
  };
}
