// Verifies the handleDrop integration contracts that can't be caught by
// the underlying library tests (parseEmlFile/parseMsgFile/deriveGreetingName):
//   1. customerName is only auto-filled when the field is currently empty.
//   2. A .msg with no extractable body leaves inquiry null but still
//      populates customerName (the TA pastes the body; the From line is free).
//   3. A from_name / from_email that deriveGreetingName can't resolve yields
//      null customerName — no [object Object] surprises.

import { describe, it, expect } from "vitest";
import { resolveEmailDrop } from "@/components/concierge/InlineDraftView";
import type { ParsedInquiry } from "@/lib/draft/parse-inquiry";

const base: ParsedInquiry = {
  from_name: "Sarah Mitchell",
  from_email: "sarah@example.com",
  subject: "Caribbean trip in July?",
  body: "Hi, I need help planning a trip to Barbados.",
};

describe("resolveEmailDrop", () => {
  it("populates inquiry and derives first name from a full parse", () => {
    const { inquiry, customerName } = resolveEmailDrop(base, "");
    expect(inquiry).toBe(base.body);
    expect(customerName).toBe("Sarah");
  });

  it("does not overwrite a pre-filled customerName", () => {
    const { customerName } = resolveEmailDrop(base, "Alice");
    expect(customerName).toBeNull();
  });

  it(".msg no-body: inquiry is null but customerName is still derived", () => {
    const parsed: ParsedInquiry = { ...base, body: null };
    const { inquiry, customerName } = resolveEmailDrop(parsed, "");
    expect(inquiry).toBeNull();
    expect(customerName).toBe("Sarah");
  });

  it("returns null customerName when greeting cannot be derived (noreply address)", () => {
    const parsed: ParsedInquiry = { from_name: null, from_email: "noreply@example.com", subject: null, body: "Hi" };
    const { customerName } = resolveEmailDrop(parsed, "");
    expect(customerName).toBeNull();
  });
});
