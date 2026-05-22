// §21.10 Layer 8 — escalation safety net tests (filed under topic_escalation).
// Why these matter: failing to escalate on a medical/legal query with weak
// retrieval is precisely the "screenshot moment" the spec warns about; firing
// on every research query trains users to ignore the prompt.

import { describe, it, expect } from "vitest";
import { checkTopicEscalation } from "@/lib/supervisor/checks/topic-escalation";

const lowChunks = [{ scoring: { composite_confidence: 0.3 } }];
const strongChunks = [{ scoring: { composite_confidence: 0.85 } }];

describe("checkTopicEscalation — §21.10 Layer 8", () => {
  it("fires on sensitive intent with weak chunks and no recent escalation", () => {
    const out = checkTopicEscalation({
      candidate_response: "Sure, your meds are fine to travel with.",
      retrieved_chunks: lowChunks,
      entities: { intent: "medical", categories_hint: [] },
      recent_escalation_offered: false,
    });
    expect(out.severity).toBe("warning");
    expect(out.details).toMatch(/suggest human handoff/);
  });

  it("does NOT fire on research intent", () => {
    const out = checkTopicEscalation({
      candidate_response: "Plenty of options.",
      retrieved_chunks: lowChunks,
      entities: { intent: "research", categories_hint: [] },
      recent_escalation_offered: false,
    });
    expect(out.severity).toBe("info");
  });

  it("does NOT fire when retrieved chunk confidence is strong", () => {
    const out = checkTopicEscalation({
      candidate_response: "x",
      retrieved_chunks: strongChunks,
      entities: { intent: "legal" },
      recent_escalation_offered: false,
    });
    expect(out.severity).toBe("info");
  });

  it("does NOT fire when escalation was offered recently", () => {
    const out = checkTopicEscalation({
      candidate_response: "x",
      retrieved_chunks: lowChunks,
      entities: { intent: "medical" },
      recent_escalation_offered: true,
    });
    expect(out.severity).toBe("info");
  });

  it("does NOT fire when persona specializes in the sensitive area", () => {
    const out = checkTopicEscalation({
      candidate_response: "x",
      retrieved_chunks: lowChunks,
      entities: { intent: "accessibility" },
      recent_escalation_offered: false,
      persona_specializes_in_sensitive: true,
    });
    expect(out.severity).toBe("info");
  });

  it("fires when categories_hint contains a sensitive category even with a generic intent", () => {
    const out = checkTopicEscalation({
      candidate_response: "x",
      retrieved_chunks: [],
      entities: { intent: "research", categories_hint: ["dietary"] },
      recent_escalation_offered: false,
    });
    expect(out.severity).toBe("warning");
  });
});
