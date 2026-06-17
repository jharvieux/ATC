// #962 — role gating for the tenant landing shell's left nav.
// #974 — role-dependent default panel at the subdomain root.
//
// Intent: the nav must never show a link the role can't use. Viewers are
// end customers — staff surfaces (CRM) and owner surfaces (Admin Console)
// would 403 via assertPermission, so showing them is a dead link.
// Every role keeps exactly one home entry at "/", but what it IS differs:
// staff land in TA mode (operator decision 2026-06-10, #974) because their
// job is trade work — the customer chat's guardrails actively get in their
// way; viewers must never default into the unguardrailed TA surface.

import { describe, it, expect } from "vitest";
import {
  navSectionsForRole,
  defaultPanelForRole,
} from "@/components/tenant-shell/nav-sections";

type Role = "tenant_owner" | "agent" | "viewer";

function hrefsFor(role: Role): string[] {
  return navSectionsForRole(role).flatMap((s) => s.items.map((i) => i.href));
}

function homeLabel(role: Role): string | undefined {
  return navSectionsForRole(role)
    .flatMap((s) => s.items)
    .find((i) => i.href === "/")?.label;
}

describe("navSectionsForRole", () => {
  it("every role gets exactly one home entry at /", () => {
    for (const role of ["tenant_owner", "agent", "viewer"] as const) {
      expect(hrefsFor(role).filter((h) => h === "/")).toHaveLength(1);
    }
  });

  it("home label matches what the role actually lands on (#974)", () => {
    // Staff's "/" renders the TA dashboard, viewers' renders the support
    // chat — a label that says otherwise is a lying nav entry.
    expect(homeLabel("tenant_owner")).toBe("Dashboard");
    expect(homeLabel("agent")).toBe("Dashboard");
    expect(homeLabel("viewer")).toBe("Support chat");
  });

  it("no role gets a separate /concierge entry — home IS the concierge for staff (#974)", () => {
    for (const role of ["tenant_owner", "agent", "viewer"] as const) {
      expect(hrefsFor(role)).not.toContain("/concierge");
    }
  });

  it("viewers see no staff or owner surfaces (no dead links)", () => {
    const hrefs = hrefsFor("viewer");
    expect(hrefs.some((h) => h.startsWith("/crm"))).toBe(false);
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/settings/usage");
  });

  it("viewers keep self-service account entries", () => {
    const hrefs = hrefsFor("viewer");
    expect(hrefs).toContain("/settings/conversations");
    expect(hrefs).toContain("/settings/price-watches");
    expect(hrefs).toContain("/settings/privacy");
  });

  it("agents get the workspace but not owner administration", () => {
    const hrefs = hrefsFor("agent");
    expect(hrefs).toContain("/crm/contacts");
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/settings/usage");
  });

  it("owners see workspace, account, and the Admin Console entry", () => {
    const hrefs = hrefsFor("tenant_owner");
    expect(hrefs).toContain("/crm/contacts");
    expect(hrefs).toContain("/settings/conversations");
    expect(hrefs).toContain("/settings");
  });

  it("admin sub-pages are no longer enumerated in the nav — they live in the console sidebar", () => {
    // The Administration group collapsed to a single Admin Console entry
    // (/settings); /settings/usage and friends moved into the console's own
    // sidebar, so the dropdown must not list them.
    expect(hrefsFor("tenant_owner")).not.toContain("/settings/usage");
  });
});

describe("defaultPanelForRole", () => {
  it("staff land in TA mode — trade topics without customer guardrails (#974)", () => {
    expect(defaultPanelForRole("tenant_owner")).toBe("ta-concierge");
    expect(defaultPanelForRole("agent")).toBe("ta-concierge");
  });

  it("viewers (end customers) keep the guardrailed customer chat", () => {
    expect(defaultPanelForRole("viewer")).toBe("customer-chat");
  });
});
