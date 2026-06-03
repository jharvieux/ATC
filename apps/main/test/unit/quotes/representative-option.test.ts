// §38.4.3 — the rule every §38 read path shares: which option a quote
// displays/renders/quotes as.
//
// Why this matters: the trip details a customer sees on the PDF, the CRM
// detail page, the AI copilot, and the expiry email all come from ONE option.
// If a customer has chosen an option, that's the one — getting this wrong
// shows the customer a different cabin/price than the one they accepted. With
// no selection, the agent's first option (lowest option_index) stands in.
// These tests fail if the precedence is inverted, if selection stops winning,
// or if the function starts assuming the DB returned rows in sorted order.

import { describe, it, expect } from "vitest";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";

interface Opt {
  option_index: number;
  customer_selected: boolean | null;
  label: string;
}

describe("selectRepresentativeOption (§38.4.3)", () => {
  it("returns null for a container with no options", () => {
    expect(selectRepresentativeOption<Opt>([])).toBeNull();
  });

  it("returns the customer-selected option even when it is not the lowest index", () => {
    const options: Opt[] = [
      { option_index: 1, customer_selected: false, label: "first" },
      { option_index: 2, customer_selected: true, label: "chosen" },
      { option_index: 3, customer_selected: null, label: "third" },
    ];
    expect(selectRepresentativeOption(options)?.label).toBe("chosen");
  });

  it("falls back to the lowest option_index when nothing is selected", () => {
    const options: Opt[] = [
      { option_index: 3, customer_selected: false, label: "third" },
      { option_index: 1, customer_selected: null, label: "first" },
      { option_index: 2, customer_selected: false, label: "second" },
    ];
    expect(selectRepresentativeOption(options)?.label).toBe("first");
  });

  it("does not assume sorted input — lowest index wins regardless of array order", () => {
    const options: Opt[] = [
      { option_index: 5, customer_selected: null, label: "high" },
      { option_index: 2, customer_selected: null, label: "low" },
    ];
    expect(selectRepresentativeOption(options)?.label).toBe("low");
  });

  it("treats only customer_selected === true as a selection (not a truthy coercion)", () => {
    const options: Opt[] = [
      { option_index: 1, customer_selected: null, label: "first" },
      { option_index: 2, customer_selected: false, label: "second" },
    ];
    // No option is truly selected → lowest index, not the first truthy-ish row.
    expect(selectRepresentativeOption(options)?.label).toBe("first");
  });
});
