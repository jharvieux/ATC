// #975 — precruiseAiContentText flattens the per-phase AI sections into the
// {{ai_content}} variable for tenant body overrides.
//
// Intent under test: every AI field the default email renders must appear in
// the flattened text — a field dropped here means a tenant who placed
// {{ai_content}} silently loses that content relative to the default email.

import { describe, it, expect } from "vitest";
import { precruiseAiContentText } from "@/inngest/precruise-generate-and-send";

describe("precruiseAiContentText", () => {
  it("t_90: includes every AI section the default template renders", () => {
    const text = precruiseAiContentText("t_90", {
      documentation_reminder: "Check your passport.",
      destination_teaser: "Nassau awaits!",
      must_do_experiences: ["Snorkel Atlantis", "Queen's Staircase"],
      did_you_know: "Nassau has the clearest waters.",
    });
    expect(text).toContain("Check your passport.");
    expect(text).toContain("Nassau awaits!");
    expect(text).toContain("• Snorkel Atlantis");
    expect(text).toContain("• Queen's Staircase");
    expect(text).toContain("Nassau has the clearest waters.");
  });

  it("t_30: includes reminders, check-in, payment note, recommendations, experiences, packing", () => {
    const text = precruiseAiContentText("t_30", {
      reservation_reminders: ["Specialty dining"],
      checkin_window: "Check-in opens day 45.",
      final_payment_note: "Final payment due.",
      personalized_recommendations: ["Sushi night"],
      specialty_experiences: ["Chef-led market tour"],
      pack_inspiration: "Pack light.",
    });
    expect(text).toContain("• Specialty dining");
    expect(text).toContain("Check-in opens day 45.");
    expect(text).toContain("Final payment due.");
    expect(text).toContain("• Sushi night");
    expect(text).toContain("• Chef-led market tour");
    expect(text).toContain("Pack light.");
  });

  it("t_7: includes packing list, highlights, tips, embarkation, first day", () => {
    const text = precruiseAiContentText("t_7", {
      packing_checklist: ["Sunscreen"],
      ship_highlights: ["Central Park"],
      cruise_line_tips: ["Board early"],
      embarkation_advice: "Arrive by 11am.",
      first_day_inspiration: "Magical first day.",
    });
    expect(text).toContain("• Sunscreen");
    expect(text).toContain("• Central Park");
    expect(text).toContain("• Board early");
    expect(text).toContain("Arrive by 11am.");
    expect(text).toContain("Magical first day.");
  });

  it("t_1: includes first port preview and day-of expectations", () => {
    const text = precruiseAiContentText("t_1", {
      first_port_preview: "Cozumel preview.",
      day_of_expectations: "Muster drill at 3pm.",
    });
    expect(text).toContain("Cozumel preview.");
    expect(text).toContain("Muster drill at 3pm.");
  });

  it("separates sections with blank lines so bodyTextToHtml makes paragraphs", () => {
    const text = precruiseAiContentText("t_1", {
      first_port_preview: "A.",
      day_of_expectations: "B.",
    });
    expect(text).toBe("A.\n\nB.");
  });

  it("drops missing/empty/non-string fields instead of rendering holes", () => {
    const text = precruiseAiContentText("t_90", {
      documentation_reminder: "",
      destination_teaser: "Teaser.",
      must_do_experiences: [42, "  ", "Real item"],
      did_you_know: null,
    });
    expect(text).toBe("Teaser.\n\n• Real item");
  });
});
