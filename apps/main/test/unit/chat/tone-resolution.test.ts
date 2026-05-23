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
