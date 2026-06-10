// #904 / D-193 decision 5 — greeting names are derived, never guessed.
// The contract: a wrong name in the TA's voice damages their client
// relationship, so anything ambiguous resolves to null → [name] placeholder.

import { describe, it, expect } from "vitest";
import { deriveGreetingName } from "@/lib/draft/greeting-name";

describe("deriveGreetingName (#904)", () => {
  it("display name first word: 'Sarah Mitchell' → Sarah", () => {
    expect(deriveGreetingName("Sarah Mitchell", "sm@x.com")).toBe("Sarah");
  });

  it("surname-first display name: 'Mitchell, Sarah' → Sarah", () => {
    expect(deriveGreetingName("Mitchell, Sarah", "sm@x.com")).toBe("Sarah");
  });

  it("quoted display name unwraps", () => {
    expect(deriveGreetingName('"Sarah Mitchell"', null)).toBe("Sarah");
  });

  it("address-as-display-name falls through to the local-part heuristic", () => {
    expect(deriveGreetingName("sarah.mitchell@x.com", "sarah.mitchell@x.com")).toBe("Sarah");
  });

  it("name-shaped local-part: sarah.mitchell@ → Sarah", () => {
    expect(deriveGreetingName(null, "sarah.mitchell@gmail.com")).toBe("Sarah");
  });

  it("role accounts are NOT names: info@/noreply@/bookings@ → null", () => {
    expect(deriveGreetingName(null, "info@agency.com")).toBeNull();
    expect(deriveGreetingName(null, "noreply@cruiseline.com")).toBeNull();
    expect(deriveGreetingName(null, "bookings@agency.com")).toBeNull();
  });

  it("digit-bearing local-parts are not names: jdoe99@ → null", () => {
    expect(deriveGreetingName(null, "jdoe99@x.com")).toBeNull();
  });

  it("nothing usable → null (the [name] placeholder contract)", () => {
    expect(deriveGreetingName(null, null)).toBeNull();
    expect(deriveGreetingName("", "")).toBeNull();
  });

  it("accented names survive title-casing", () => {
    expect(deriveGreetingName("josé garcía", null)).toBe("José");
  });
});
