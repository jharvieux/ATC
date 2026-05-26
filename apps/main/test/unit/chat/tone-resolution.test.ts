// §24.5 — resolveToneLevel covers the table of cases in the build prompt:
//   • Customer apparent + tenant max + persona base → midpoint, capped
//   • Topic override pulls level DOWN
//   • Customer rapport_tone_level acts as a floor
//   • "direct" directive clamps to ≤2

import { describe, it, expect } from "vitest";
import { resolveToneLevel } from "@/lib/chat/tone-resolution";

describe("resolveToneLevel", () => {
  it("uses persona base when customer is neutral and within tenant max", () => {
    const r = resolveToneLevel({
      tenant_max_level: 3,
      persona_slug: "marcus-cole", // base 3
      customer_rapport_level: null,
      customer_rapport_directive: null,
      customer_message: "Tell me about cruises.",
    });
    expect(r.level).toBeGreaterThanOrEqual(2);
    expect(r.level).toBeLessThanOrEqual(3);
  });

  it("caps at tenant_max_level when persona+customer would go higher", () => {
    const r = resolveToneLevel({
      tenant_max_level: 2,
      persona_slug: "marcus-cole",
      customer_rapport_level: 5,
      customer_rapport_directive: null,
      customer_message: "yo hey what's up!!",
    });
    expect(r.level).toBeLessThanOrEqual(2);
  });

  it("medical_accessibility topic forces level 1-2", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: 5,
      customer_rapport_directive: null,
      customer_message: "I have a wheelchair and need accessible cabins!!",
      topic: "medical_accessibility",
    });
    expect(r.level).toBeLessThanOrEqual(2);
    expect(r.source).toBe("topic_override");
  });

  it("customer 'direct' directive clamps to ≤2", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: 4,
      customer_rapport_directive: "direct",
      customer_message: "Tell me about cabins.",
    });
    expect(r.level).toBeLessThanOrEqual(2);
    expect(r.source).toBe("customer_override");
  });

  it("customer_rapport_level above current bumps level up (capped by tenant)", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "priya-sharma", // base 2
      customer_rapport_level: 4,
      customer_rapport_directive: null,
      customer_message: "Hi.",
    });
    expect(r.level).toBe(4);
    expect(r.source).toBe("customer_override");
  });

  it("casual customer message pushes upward but never above tenant_max", () => {
    const r = resolveToneLevel({
      tenant_max_level: 4,
      persona_slug: "marcus-cole",
      customer_rapport_level: null,
      customer_rapport_directive: null,
      customer_message: "hey yo lol gonna book something cool!!",
    });
    expect(r.level).toBeLessThanOrEqual(4);
    expect(r.level).toBeGreaterThanOrEqual(3);
  });
});

// -- Boundary + branch coverage (Stryker-driven) ---------------------------

describe("resolveToneLevel — tenant max boundaries", () => {
  it("tenant_max_level=0 clamps to 1 (Math.max floor)", () => {
    const r = resolveToneLevel({
      tenant_max_level: 0,
      persona_slug: "marcus-cole",
      customer_rapport_level: null,
      customer_rapport_directive: null,
      customer_message: "Hi.",
    });
    expect(r.level).toBeGreaterThanOrEqual(1);
    expect(r.level).toBeLessThanOrEqual(5);
  });
  it("tenant_max_level=6 clamps to 5 (Math.min ceiling)", () => {
    const r = resolveToneLevel({
      tenant_max_level: 6,
      persona_slug: "marcus-cole",
      customer_rapport_level: 5,
      customer_rapport_directive: null,
      customer_message: "yo lol omg amazing!! gotta book!!",
    });
    expect(r.level).toBeLessThanOrEqual(5);
  });
  it("tenant_max_level missing/0 falls back to default 3", () => {
    const r = resolveToneLevel({
      tenant_max_level: 0,
      persona_slug: "marcus-cole",
      customer_rapport_level: 5,
      customer_rapport_directive: null,
      customer_message: "hey yo lol gonna book!!",
    });
    expect(r.level).toBeLessThanOrEqual(3);
  });
});

describe("resolveToneLevel — topic overrides (every topic)", () => {
  function base() {
    return {
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: 5,
      customer_rapport_directive: null as null | "direct",
      customer_message: "yo lol omg!!",
    };
  }
  it("financial caps at 2-3", () => {
    const r = resolveToneLevel({ ...base(), topic: "financial" });
    expect(r.level).toBeGreaterThanOrEqual(2);
    expect(r.level).toBeLessThanOrEqual(3);
    expect(r.source).toBe("topic_override");
  });
  it("cancellation_complaint caps at 1-2", () => {
    const r = resolveToneLevel({ ...base(), topic: "cancellation_complaint" });
    expect(r.level).toBeGreaterThanOrEqual(1);
    expect(r.level).toBeLessThanOrEqual(2);
  });
  it("booking_confirmation pinned exactly to 2", () => {
    const r = resolveToneLevel({ ...base(), topic: "booking_confirmation" });
    expect(r.level).toBe(2);
  });
  it("casual_exploration does NOT override (1-5 range = no cap)", () => {
    const r = resolveToneLevel({ ...base(), topic: "casual_exploration" });
    expect(r.source).not.toBe("topic_override");
  });
  it("topic override can ALSO bump level UP (financial floor)", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: 1,
      customer_rapport_directive: "direct",
      customer_message: "Refund?",
      topic: "financial",
    });
    // financial min is 2 — even with direct directive clamping to ≤2,
    // the floor pushes back UP if it would be below.
    expect(r.level).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveToneLevel — customer rapport floor semantics", () => {
  it("rapport_level=null → no override applied", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: null,
      customer_rapport_directive: null,
      customer_message: "Hello.",
    });
    expect(r.source).not.toBe("customer_override");
  });
  it("rapport_level BELOW current level does NOT pull down", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole", // base 3
      customer_rapport_level: 1,
      customer_rapport_directive: null,
      customer_message: "hey yo lol amazing!!",
    });
    // customer_override only fires if override > current level. So with
    // override=1 < inferred ~3, override does NOT apply (floor semantics).
    expect(r.source).not.toBe("customer_override");
  });
  it("'direct' directive clamps even when other inputs push higher", () => {
    const r = resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: 5, // would normally push to 5
      customer_rapport_directive: "direct",
      customer_message: "yo lol omg!!",
    });
    expect(r.level).toBeLessThanOrEqual(2);
  });
});

describe("inferCustomerStyle — signal counting (via resolveToneLevel)", () => {
  function inferLevel(message: string) {
    return resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "marcus-cole",
      customer_rapport_level: null,
      customer_rapport_directive: null,
      customer_message: message,
    }).level;
  }
  it("zero casual signals → low inferred (2)", () => {
    const lvl = inferLevel("Please describe the cabin options.");
    expect(lvl).toBeLessThanOrEqual(3);
  });
  it("multiple signals → higher level", () => {
    const a = inferLevel("Please describe the cabin options.");
    const b = inferLevel("hey yo lol gonna book amazing!!");
    expect(b).toBeGreaterThan(a);
  });
});

describe("resolveToneLevel — apostrophe normalization (regression)", () => {
  // Bug history: the contraction regex used /[''/]\w+/ which only matched
  // ASCII apostrophe (U+0027). iOS/macOS/Word auto-replace `'` with `’`
  // (U+2019), so contractions from any mobile or modern desktop user were
  // silently missed → the casual-signal count under-counted → resolved
  // tone level was lower than the customer's actual style. Fixed by
  // expanding the regex to include both code points.
  function levelFor(message: string) {
    return resolveToneLevel({
      tenant_max_level: 5,
      persona_slug: "priya-sharma", // base 2 so signals can swing the level
      customer_rapport_level: null,
      customer_rapport_directive: null,
      customer_message: message,
    }).level;
  }
  it("ASCII apostrophe (don't, can't) is counted as a contraction signal", () => {
    expect(levelFor("don't tell me, can't decide!")).toBe(4);
  });
  it("Curly apostrophe (don’t, can’t) is counted as a contraction signal", () => {
    expect(levelFor("don’t tell me, can’t decide!")).toBe(4);
  });
  it("no apostrophe → baseline level 2", () => {
    expect(levelFor("Tell me about cabins, please.")).toBe(2);
  });
});
