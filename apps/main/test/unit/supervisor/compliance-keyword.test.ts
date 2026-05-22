// §10.2 / §9.7 — compliance_keyword tests.
// Why these matter: a missed advice phrase ships forbidden content to the
// customer; a false positive trains operators to ignore the warnings.

import { describe, it, expect } from "vitest";
import { checkComplianceKeyword } from "@/lib/supervisor/checks/compliance-keyword";

describe("checkComplianceKeyword — §10.2", () => {
  it("flags medical advice phrasing", () => {
    const out = checkComplianceKeyword({
      candidate_response: "You should stop taking your medication before the cruise.",
    });
    expect(out.severity).toBe("critical");
    expect(out.details).toMatch(/medical/);
  });

  it("flags legal-conclusion phrasing", () => {
    const out = checkComplianceKeyword({
      candidate_response: "This is legally binding once you sign.",
    });
    expect(out.severity).toBe("critical");
  });

  it("flags definitive investment advice", () => {
    const out = checkComplianceKeyword({
      candidate_response: "You should invest in trip insurance every time.",
    });
    expect(out.severity).toBe("critical");
  });

  it("ignores neutral travel prose", () => {
    const out = checkComplianceKeyword({
      candidate_response: "Wonder of the Seas has 18 decks and great dining options.",
    });
    expect(out.severity).toBe("info");
  });
});
