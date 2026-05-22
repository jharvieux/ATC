// Unit tests for promise_detection check — §10.2
// The promise phrases are the "why": they represent liability commitments
// the platform cannot honor. A regression here means an over-committed
// response reaching a customer without a regen attempt.

import { describe, it, expect } from "vitest";
import { checkPromiseDetection } from "@/lib/supervisor/checks/promise-detection";

describe("checkPromiseDetection", () => {
  it("flags 'guaranteed'", () => {
    const result = checkPromiseDetection({
      candidate_response: "Your cabin is guaranteed to have an ocean view.",
    });
    expect(result.severity).toBe("warning");
    expect(result.details).toContain("guaranteed");
  });

  it("flags 'I assure you' (case-insensitive)", () => {
    const result = checkPromiseDetection({
      candidate_response: "I assure you this ship never has engine issues.",
    });
    expect(result.severity).toBe("warning");
  });

  it("flags 'I promise'", () => {
    const result = checkPromiseDetection({
      candidate_response: "I promise the dining upgrade will be available.",
    });
    expect(result.severity).toBe("warning");
  });

  it("flags 'rest assured'", () => {
    const result = checkPromiseDetection({
      candidate_response: "Rest assured, your booking is fully secure.",
    });
    expect(result.severity).toBe("warning");
  });

  it("flags 'will definitely'", () => {
    const result = checkPromiseDetection({
      candidate_response: "The captain will definitely accommodate your request.",
    });
    expect(result.severity).toBe("warning");
  });

  it("flags 'always available'", () => {
    const result = checkPromiseDetection({
      candidate_response: "The specialty dining is always available on this ship.",
    });
    expect(result.severity).toBe("warning");
  });

  it("passes clean hedged language", () => {
    const result = checkPromiseDetection({
      candidate_response:
        "Ocean-view cabins are typically available and usually include a balcony.",
    });
    expect(result.severity).toBe("info");
  });

  it("passes empty response", () => {
    const result = checkPromiseDetection({ candidate_response: "" });
    expect(result.severity).toBe("info");
  });

  it("check name is 'promise_detection'", () => {
    const result = checkPromiseDetection({ candidate_response: "guaranteed" });
    expect(result.check).toBe("promise_detection");
  });
});
