/**
 * BP31 §32.4.3 — Help AI flow state machines.
 *
 * Three flows: help / bug / feature. Each one's conversation state lives
 * in the `help_sessions.session_type` + a per-session draft object that
 * the route handler persists into the conversation context (caller
 * concern; this lib is pure logic).
 *
 *   - **help flow:** open Q&A. State is "active" → "escalated" (after 3
 *     low-confidence-RAG messages) → "ended".
 *   - **bug flow:** seven-prompt structured gathering. The Help AI asks
 *     each prompt in order, persisting the answer to a working `BugDraft`.
 *     After all answers gathered → compute confidence → show summary →
 *     submit. The user can edit before submit.
 *   - **feature flow:** four-prompt structured gathering. Lighter weight.
 *
 * The state machine here is the single source of truth for "what should
 * the Help AI ask next?". The conversation handler reads the current
 * state + the draft, then either:
 *   - generates the next prompt question, OR
 *   - emits the showing_summary view, OR
 *   - emits the submitted confirmation.
 */

export type FlowType = "help" | "bug" | "feature";

// ---------------------------------------------------------------------------
// Bug flow state machine
// ---------------------------------------------------------------------------

export type BugFlowState =
  | "gathering_location"
  | "gathering_actual"
  | "gathering_expected"
  | "gathering_steps"
  | "gathering_frequency"
  | "confirming_environment"
  | "optional_screenshots"
  | "showing_summary"
  | "submitted";

export interface BugDraft {
  where_in_platform: string | null;
  actual_behavior: string | null;
  expected_behavior: string | null;
  steps_to_reproduce: string | null;
  frequency: "always" | "sometimes" | "once" | "unknown" | null;
  browser_info: { browser?: string; os?: string; viewport?: string } | null;
  screenshots: string[];
}

export const EMPTY_BUG_DRAFT: BugDraft = {
  where_in_platform: null,
  actual_behavior: null,
  expected_behavior: null,
  steps_to_reproduce: null,
  frequency: null,
  browser_info: null,
  screenshots: [],
};

/** Ordered list of (state, next-question, draft-field) so the controller
 * knows which field to update on each user reply. The browser/screenshot
 * states accept structured replies (auto-detect + drag-drop) rather than
 * free-text answers — drafts get updated by the UI for those. */
export const BUG_FLOW_STEPS: ReadonlyArray<{
  state: BugFlowState;
  question: string;
  capture_field?: keyof BugDraft;
  next: BugFlowState;
}> = [
  {
    state: "gathering_location",
    question: "Where in the platform did this happen? A URL or feature name works — like `/admin/branding` or 'custom domain setup'.",
    capture_field: "where_in_platform",
    next: "gathering_actual",
  },
  {
    state: "gathering_actual",
    question: "What is it doing? Describe what you actually saw — the unexpected part.",
    capture_field: "actual_behavior",
    next: "gathering_expected",
  },
  {
    state: "gathering_expected",
    question: "What should it be doing? What did you expect instead?",
    capture_field: "expected_behavior",
    next: "gathering_steps",
  },
  {
    state: "gathering_steps",
    question: "Walk me through the steps to reproduce this. Be as specific as you can — start from where you were, then each click or action.",
    capture_field: "steps_to_reproduce",
    next: "gathering_frequency",
  },
  {
    state: "gathering_frequency",
    question: "How often does this happen — always, sometimes, or just the once?",
    capture_field: "frequency",
    next: "confirming_environment",
  },
  {
    state: "confirming_environment",
    question: "I'll auto-detect your browser and OS — does this look right? `{{browser_info_detected}}`",
    capture_field: "browser_info",
    next: "optional_screenshots",
  },
  {
    state: "optional_screenshots",
    question: "Optional: drag in screenshots that help explain. Otherwise reply 'skip' and I'll move on.",
    capture_field: "screenshots",
    next: "showing_summary",
  },
  {
    state: "showing_summary",
    question: "{{summary_view}}",
    next: "submitted",
  },
] as const;

/** Find the step descriptor for a given state. */
export function bugStepFor(state: BugFlowState): (typeof BUG_FLOW_STEPS)[number] | undefined {
  return BUG_FLOW_STEPS.find((s) => s.state === state);
}

/**
 * BP32 §32.10.3 — customer-chat wording for each bug-flow state.
 *
 * When `source_surface = 'customer_chat'`, the chat handler injects
 * these phrasings instead of the tenant-admin defaults. The state
 * machine + capture fields are identical — only the prompt text changes.
 */
export const BUG_FLOW_QUESTIONS_CUSTOMER: Record<BugFlowState, string> = {
  gathering_location: "Where were you when you noticed this?",
  gathering_actual: "What happened?",
  gathering_expected: "What did you expect to happen?",
  gathering_steps: "Can you walk me through exactly what you did?",
  gathering_frequency: "Did this happen once, or has it happened more than once?",
  confirming_environment: "I'll grab your browser info — does this look right?",
  optional_screenshots: "Want to send a screenshot? Drag it into the chat or upload.",
  showing_summary: "{{summary_view}}",
  submitted: "",
};

/**
 * Get the question text for a state, source-surface aware.
 * Source 'customer_chat' → the §32.10.3 friendly phrasings above.
 * Source 'admin' → the tenant-admin defaults from BUG_FLOW_STEPS.
 */
export function bugQuestionForState(
  state: BugFlowState,
  source_surface: "admin" | "customer_chat",
): string {
  if (source_surface === "customer_chat") {
    return BUG_FLOW_QUESTIONS_CUSTOMER[state] ?? "";
  }
  return bugStepFor(state)?.question ?? "";
}

/** Advance a bug draft + state in response to a user reply. */
export function advanceBugFlow(
  state: BugFlowState,
  draft: BugDraft,
  userReply: string,
): { state: BugFlowState; draft: BugDraft } {
  if (state === "submitted") {
    return { state, draft }; // terminal
  }
  const step = bugStepFor(state);
  if (!step) {
    throw new Error(`Unknown bug flow state: ${state}`);
  }
  const newDraft: BugDraft = { ...draft };
  if (step.capture_field === "frequency") {
    const lower = userReply.trim().toLowerCase();
    const matched: BugDraft["frequency"] =
      lower.startsWith("always")
        ? "always"
        : lower.startsWith("sometimes")
          ? "sometimes"
          : lower.startsWith("once") || lower.startsWith("just")
            ? "once"
            : "unknown";
    newDraft.frequency = matched;
  } else if (step.capture_field === "screenshots") {
    // Free-text "skip" leaves screenshots as-is; the UI uploads
    // populate this separately.
    // No-op here.
  } else if (step.capture_field && step.capture_field !== "browser_info") {
    (newDraft as unknown as Record<string, unknown>)[step.capture_field as string] = userReply.trim();
  }
  return { state: step.next, draft: newDraft };
}

/** Returns true when the bug draft has enough to compute confidence + submit. */
export function bugDraftIsComplete(draft: BugDraft): boolean {
  return (
    !!draft.where_in_platform &&
    !!draft.actual_behavior &&
    !!draft.expected_behavior &&
    !!draft.steps_to_reproduce &&
    !!draft.frequency
  );
}

// ---------------------------------------------------------------------------
// Feature flow state machine
// ---------------------------------------------------------------------------

export type FeatureFlowState =
  | "gathering_what"
  | "gathering_why"
  | "gathering_workaround"
  | "gathering_frequency"
  | "showing_summary"
  | "submitted";

export interface FeatureDraft {
  what: string | null;
  why: string | null;
  current_workaround: string | null;
  expected_usage_frequency: string | null;
}

export const EMPTY_FEATURE_DRAFT: FeatureDraft = {
  what: null,
  why: null,
  current_workaround: null,
  expected_usage_frequency: null,
};

export const FEATURE_FLOW_STEPS: ReadonlyArray<{
  state: FeatureFlowState;
  question: string;
  capture_field?: keyof FeatureDraft;
  next: FeatureFlowState;
}> = [
  {
    state: "gathering_what",
    question: "What do you want to do? Describe the feature in your own words.",
    capture_field: "what",
    next: "gathering_why",
  },
  {
    state: "gathering_why",
    question: "Why? What problem does it solve for you?",
    capture_field: "why",
    next: "gathering_workaround",
  },
  {
    state: "gathering_workaround",
    question: "How do you handle this today — what's your current workaround?",
    capture_field: "current_workaround",
    next: "gathering_frequency",
  },
  {
    state: "gathering_frequency",
    question: "How often would you use this — daily, weekly, monthly, occasionally?",
    capture_field: "expected_usage_frequency",
    next: "showing_summary",
  },
  {
    state: "showing_summary",
    question: "{{summary_view}}",
    next: "submitted",
  },
] as const;

export function featureStepFor(state: FeatureFlowState): (typeof FEATURE_FLOW_STEPS)[number] | undefined {
  return FEATURE_FLOW_STEPS.find((s) => s.state === state);
}

export function advanceFeatureFlow(
  state: FeatureFlowState,
  draft: FeatureDraft,
  userReply: string,
): { state: FeatureFlowState; draft: FeatureDraft } {
  if (state === "submitted") return { state, draft };
  const step = featureStepFor(state);
  if (!step) throw new Error(`Unknown feature flow state: ${state}`);
  const newDraft: FeatureDraft = { ...draft };
  if (step.capture_field) {
    (newDraft as unknown as Record<string, unknown>)[step.capture_field as string] = userReply.trim();
  }
  return { state: step.next, draft: newDraft };
}

export function featureDraftIsComplete(draft: FeatureDraft): boolean {
  return !!draft.what && !!draft.why && !!draft.expected_usage_frequency;
}

// ---------------------------------------------------------------------------
// Help flow — open Q&A
// ---------------------------------------------------------------------------

export type HelpFlowState = "active" | "should_escalate" | "ended";

/**
 * §32.4.3: "If the Help AI cannot answer with sufficient confidence (RAG
 * returns no chunks above 0.5 confidence threshold) after 3 user messages:
 * the AI suggests escalation to platform support."
 *
 * The Help AI route handler maintains `lowConfidenceStreak` per session.
 */
export function advanceHelpFlow(
  state: HelpFlowState,
  ragAnsweredConfidently: boolean,
  lowConfidenceStreak: number,
): { state: HelpFlowState; lowConfidenceStreak: number } {
  if (state === "ended") return { state, lowConfidenceStreak };
  const nextStreak = ragAnsweredConfidently ? 0 : lowConfidenceStreak + 1;
  if (nextStreak >= 3) {
    return { state: "should_escalate", lowConfidenceStreak: nextStreak };
  }
  return { state: "active", lowConfidenceStreak: nextStreak };
}
