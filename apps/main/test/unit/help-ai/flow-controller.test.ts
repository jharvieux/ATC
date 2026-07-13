// BP31 §32.4.3 — Help AI flow controller tests.

import { describe, it, expect } from "vitest";
import {
  EMPTY_BUG_DRAFT,
  EMPTY_FEATURE_DRAFT,
  advanceBugFlow,
  advanceFeatureFlow,
  advanceHelpFlow,
  bugDraftIsComplete,
  bugStepFor,
  bugQuestionForState,
  BUG_FLOW_QUESTIONS_CUSTOMER,
  featureDraftIsComplete,
  featureStepFor,
  BUG_FLOW_STEPS,
  FEATURE_FLOW_STEPS,
} from "@/lib/help-ai/flow-controller";

describe("bug flow state machine", () => {
  it("walks the 8-state sequence ending at 'submitted'", () => {
    let state: ReturnType<typeof advanceBugFlow>["state"] = "gathering_location";
    let draft = { ...EMPTY_BUG_DRAFT };

    ({ state, draft } = advanceBugFlow(state, draft, "/admin/branding"));
    expect(state).toBe("gathering_actual");
    expect(draft.where_in_platform).toBe("/admin/branding");

    ({ state, draft } = advanceBugFlow(state, draft, "Stays on Pending"));
    expect(state).toBe("gathering_expected");
    expect(draft.actual_behavior).toBe("Stays on Pending");

    ({ state, draft } = advanceBugFlow(state, draft, "Should verify in minutes"));
    expect(state).toBe("gathering_steps");

    ({ state, draft } = advanceBugFlow(state, draft, "Add CNAME, refresh"));
    expect(state).toBe("gathering_frequency");

    ({ state, draft } = advanceBugFlow(state, draft, "always"));
    expect(state).toBe("confirming_environment");
    expect(draft.frequency).toBe("always");

    ({ state, draft } = advanceBugFlow(state, draft, "looks right"));
    expect(state).toBe("optional_screenshots");

    ({ state, draft } = advanceBugFlow(state, draft, "skip"));
    expect(state).toBe("showing_summary");

    ({ state, draft } = advanceBugFlow(state, draft, ""));
    expect(state).toBe("submitted");
  });

  it("normalizes frequency replies", () => {
    expect(advanceBugFlow("gathering_frequency", { ...EMPTY_BUG_DRAFT }, "Always").draft.frequency).toBe("always");
    expect(advanceBugFlow("gathering_frequency", { ...EMPTY_BUG_DRAFT }, "sometimes").draft.frequency).toBe("sometimes");
    expect(advanceBugFlow("gathering_frequency", { ...EMPTY_BUG_DRAFT }, "Just the once").draft.frequency).toBe("once");
    expect(advanceBugFlow("gathering_frequency", { ...EMPTY_BUG_DRAFT }, "not sure").draft.frequency).toBe("unknown");
  });

  it("submitted is terminal — no further state changes", () => {
    const before = { state: "submitted" as const, draft: { ...EMPTY_BUG_DRAFT } };
    const after = advanceBugFlow(before.state, before.draft, "anything");
    expect(after.state).toBe("submitted");
  });

  it("bugDraftIsComplete returns true only when all required fields are populated", () => {
    expect(bugDraftIsComplete(EMPTY_BUG_DRAFT)).toBe(false);
    expect(
      bugDraftIsComplete({
        ...EMPTY_BUG_DRAFT,
        where_in_platform: "/x",
        actual_behavior: "y",
        expected_behavior: "z",
        steps_to_reproduce: "1",
      }),
    ).toBe(false); // missing frequency
    expect(
      bugDraftIsComplete({
        ...EMPTY_BUG_DRAFT,
        where_in_platform: "/x",
        actual_behavior: "y",
        expected_behavior: "z",
        steps_to_reproduce: "1",
        frequency: "always",
      }),
    ).toBe(true);
  });

  it("bugStepFor returns the right step descriptor", () => {
    expect(bugStepFor("gathering_location")?.capture_field).toBe("where_in_platform");
    expect(bugStepFor("submitted")).toBeUndefined();
  });

  it("BUG_FLOW_STEPS covers every gathering state plus showing_summary", () => {
    const states = BUG_FLOW_STEPS.map((s) => s.state);
    expect(states).toEqual([
      "gathering_location",
      "gathering_actual",
      "gathering_expected",
      "gathering_steps",
      "gathering_frequency",
      "confirming_environment",
      "optional_screenshots",
      "showing_summary",
    ]);
  });
});

describe("feature flow state machine", () => {
  it("walks the 5-state sequence ending at 'submitted'", () => {
    let state: ReturnType<typeof advanceFeatureFlow>["state"] = "gathering_what";
    let draft = { ...EMPTY_FEATURE_DRAFT };

    ({ state, draft } = advanceFeatureFlow(state, draft, "Bulk export contacts"));
    expect(state).toBe("gathering_why");
    expect(draft.what).toBe("Bulk export contacts");

    ({ state, draft } = advanceFeatureFlow(state, draft, "Monthly compliance"));
    expect(state).toBe("gathering_workaround");

    ({ state, draft } = advanceFeatureFlow(state, draft, "Manual CSV copy"));
    expect(state).toBe("gathering_frequency");

    ({ state, draft } = advanceFeatureFlow(state, draft, "monthly"));
    expect(state).toBe("showing_summary");

    ({ state, draft } = advanceFeatureFlow(state, draft, ""));
    expect(state).toBe("submitted");
  });

  it("featureDraftIsComplete requires what + why + frequency", () => {
    expect(featureDraftIsComplete(EMPTY_FEATURE_DRAFT)).toBe(false);
    expect(
      featureDraftIsComplete({
        what: "x",
        why: "y",
        current_workaround: null,
        expected_usage_frequency: "monthly",
      }),
    ).toBe(true);
  });

  it("FEATURE_FLOW_STEPS covers every gathering state plus showing_summary", () => {
    const states = FEATURE_FLOW_STEPS.map((s) => s.state);
    expect(states).toEqual([
      "gathering_what",
      "gathering_why",
      "gathering_workaround",
      "gathering_frequency",
      "showing_summary",
    ]);
  });

  it("featureStepFor returns the right descriptor", () => {
    expect(featureStepFor("gathering_what")?.capture_field).toBe("what");
    expect(featureStepFor("submitted")).toBeUndefined();
  });
});

describe("help flow escalation rule (§32.4.3)", () => {
  it("resets the low-confidence streak when RAG answers confidently", () => {
    const result = advanceHelpFlow("active", true, 2);
    expect(result.state).toBe("active");
    expect(result.lowConfidenceStreak).toBe(0);
  });

  it("advances to should_escalate after 3 consecutive low-confidence answers", () => {
    let s = advanceHelpFlow("active", false, 0);
    expect(s.state).toBe("active");
    expect(s.lowConfidenceStreak).toBe(1);

    s = advanceHelpFlow(s.state, false, s.lowConfidenceStreak);
    expect(s.state).toBe("active");
    expect(s.lowConfidenceStreak).toBe(2);

    s = advanceHelpFlow(s.state, false, s.lowConfidenceStreak);
    expect(s.state).toBe("should_escalate");
    expect(s.lowConfidenceStreak).toBe(3);
  });

  it("stays in 'ended' regardless of input", () => {
    const s = advanceHelpFlow("ended", false, 5);
    expect(s.state).toBe("ended");
  });
});

describe("bugQuestionForState — source-surface wording (§32.10.3)", () => {
  // The message route now routes customer_chat sessions through this
  // dispatcher; a regression here means customers get admin-toned prompts.
  it("returns the friendlier customer copy for customer_chat", () => {
    expect(bugQuestionForState("gathering_steps", "customer_chat")).toBe(
      "Can you walk me through exactly what you did?",
    );
    expect(bugQuestionForState("gathering_actual", "customer_chat")).toBe("What happened?");
  });

  it("returns the tenant-admin default for admin", () => {
    expect(bugQuestionForState("gathering_steps", "admin")).toBe(
      bugStepFor("gathering_steps")?.question,
    );
  });

  it("customer and admin wording diverge for every gathering state", () => {
    const states = ["gathering_location", "gathering_actual", "gathering_expected", "gathering_steps", "gathering_frequency"] as const;
    for (const s of states) {
      expect(bugQuestionForState(s, "customer_chat")).toBe(BUG_FLOW_QUESTIONS_CUSTOMER[s]);
      expect(bugQuestionForState(s, "customer_chat")).not.toBe(bugQuestionForState(s, "admin"));
    }
  });

  it("terminal 'submitted' state yields empty string on both surfaces (route falls back)", () => {
    expect(bugQuestionForState("submitted", "customer_chat")).toBe("");
    expect(bugQuestionForState("submitted", "admin")).toBe("");
  });
});
