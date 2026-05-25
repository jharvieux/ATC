// BP37 §37.4.4 — template substitution tests.

import { describe, expect, it } from "vitest";
import { applyTemplate } from "@/lib/tasks/template";

describe("applyTemplate", () => {
  it("substitutes contact fields", () => {
    expect(applyTemplate("Hi {{contact.first_name}} {{contact.last_name}}", {
      contact: { first_name: "Jane", last_name: "Doe" },
    })).toBe("Hi Jane Doe");
  });

  it("empty-strings missing variables", () => {
    expect(applyTemplate("Hi {{contact.first_name}}!", {})).toBe("Hi !");
    expect(applyTemplate("{{quote.cruise_line}}", {})).toBe("");
  });

  it("substitutes booking + days_until_sailing", () => {
    expect(applyTemplate("{{booking.cruise_line}} in {{days_until_sailing}}d", {
      booking: { cruise_line: "Royal Caribbean" },
      days_until_sailing: 42,
    })).toBe("Royal Caribbean in 42d");
  });

  it("does not interpret unrecognized templates (literal pass-through)", () => {
    expect(applyTemplate("{{unknown.foo}}", {})).toBe("{{unknown.foo}}");
  });

  it("no template injection — literal output only", () => {
    expect(applyTemplate("{{contact.first_name}}", { contact: { first_name: "<script>" } })).toBe("<script>");
  });
});
