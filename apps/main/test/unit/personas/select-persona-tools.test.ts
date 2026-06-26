// §9.6 — tool gating by audience + tenant tier.
//
// WHY this matters (live bug): the persona model was handed search_host_inventory
// in every context. For a BYO agency it returned a "real-time inventory isn't
// connected yet" stub, which the concierge relayed verbatim to a travel pro as
// "our inventory system isn't live yet" — wrong on two counts (BYO agencies use
// their OWN booking system, and the agency staff is not a customer to escalate
// to "our agent team"). These tests pin that the "our booking system" tools are
// withheld from BYO tenants and TA-mode turns, so the concierge grounds sailing
// answers in RAG instead of reaching for the stub.

import { describe, it, expect } from "vitest";
import { selectPersonaTools, PERSONA_TOOLS } from "@/lib/personas/tools";

const names = (tools: { name: string }[]) => tools.map((t) => t.name);

describe("selectPersonaTools", () => {
  it("withholds search_host_inventory / generate_quote / collect_booking_details from BYO tenants", () => {
    const tools = names(selectPersonaTools({ audience: "customer", tenantTier: "byo_agency" }));
    expect(tools).not.toContain("search_host_inventory");
    expect(tools).not.toContain("generate_quote");
    expect(tools).not.toContain("collect_booking_details");
  });

  it("withholds the our-booking-system tools in TA mode regardless of tier", () => {
    const tools = names(selectPersonaTools({ audience: "tenant_member", tenantTier: "sub_pro" }));
    expect(tools).not.toContain("search_host_inventory");
    expect(tools).not.toContain("generate_quote");
    expect(tools).not.toContain("collect_booking_details");
  });

  it("also drops customer-only update_memory in TA mode (no customer on the far end)", () => {
    const tools = names(selectPersonaTools({ audience: "tenant_member", tenantTier: "sub_pro" }));
    expect(tools).not.toContain("update_memory");
  });

  it("keeps the full tool set for a non-BYO customer conversation", () => {
    const tools = selectPersonaTools({ audience: "customer", tenantTier: "sub_pro" });
    expect(tools).toBe(PERSONA_TOOLS);
    expect(names(tools)).toContain("search_host_inventory");
  });

  it("still exposes non-booking tools (escalate_to_human) to a BYO customer", () => {
    const tools = names(selectPersonaTools({ audience: "customer", tenantTier: "byo_research" }));
    expect(tools).toContain("escalate_to_human");
  });
});
