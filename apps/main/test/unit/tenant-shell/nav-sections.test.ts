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
  sidebarSectionsForRole,
  hamburgerSectionsForRole,
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

  it("agents see account links but not workspace CRM or owner administration", () => {
    // Workspace items (CRM, Groups, etc.) are sidebar-only; the hamburger
    // shows only account-level links for staff.
    const hrefs = hrefsFor("agent");
    expect(hrefs).toContain("/settings/conversations");
    expect(hrefs).not.toContain("/crm/contacts");
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/settings/usage");
  });

  it("owners see account links and Admin Console but not workspace CRM", () => {
    // Same as agents: workspace items are sidebar-only.
    const hrefs = hrefsFor("tenant_owner");
    expect(hrefs).not.toContain("/crm/contacts");
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

describe("sidebarSectionsForRole", () => {
  function sidebarHrefsFor(role: Parameters<typeof sidebarSectionsForRole>[0]): string[] {
    return sidebarSectionsForRole(role).flatMap((s) => s.items.map((i) => i.href));
  }

  it("staff see all workspace items including Group Bookings in the sidebar", () => {
    for (const role of ["agent", "tenant_owner"] as const) {
      const hrefs = sidebarHrefsFor(role);
      expect(hrefs).toContain("/crm/contacts");
      expect(hrefs).toContain("/crm/bookings");
      expect(hrefs).toContain("/groups");
    }
  });

  it("viewers do not see workspace CRM or Group Bookings in the sidebar", () => {
    const hrefs = sidebarHrefsFor("viewer");
    expect(hrefs).not.toContain("/crm/contacts");
    expect(hrefs).not.toContain("/groups");
  });

  // Role-routing invariants: these tests fail if the routing logic is reverted
  // or if Admin Console / price-watches are moved between roles.

  it("tenant_owner gets Admin Console section in the sidebar", () => {
    // The Admin Console entry (/settings) must appear for owners in the sidebar
    // so they can navigate to tenant administration.
    expect(sidebarHrefsFor("tenant_owner")).toContain("/settings");
  });

  it("agent (staff) does NOT get Admin Console in the sidebar", () => {
    // Agents are staff but not owners — /settings is an owner-only surface.
    expect(sidebarHrefsFor("agent")).not.toContain("/settings");
  });

  it("viewer does NOT get Admin Console in the sidebar", () => {
    // Viewers are customers — they must never see the Admin Console entry.
    expect(sidebarHrefsFor("viewer")).not.toContain("/settings");
  });

  it("staff get price-watches inside the Workspace section in the sidebar", () => {
    // Price watches are operational for TAs managing many customer watches,
    // so they belong under the Workspace heading, not My account.
    for (const role of ["agent", "tenant_owner"] as const) {
      const sections = sidebarSectionsForRole(role);
      const workspaceSection = sections.find((s) => s.heading === "Workspace");
      expect(workspaceSection, `${role} must have a Workspace sidebar section`).toBeDefined();
      const workspaceHrefs = workspaceSection!.items.map((i) => i.href);
      expect(workspaceHrefs).toContain("/settings/price-watches");
    }
  });

  it("viewers do not see price-watches in the sidebar at all", () => {
    // The sidebar has no My account section — price watches for viewers live
    // in the hamburger dropdown (My account), not the sidebar.
    expect(sidebarHrefsFor("viewer")).not.toContain("/settings/price-watches");
  });

});

// ── Price-watches section ownership invariant ────────────────────────────────
// Pinned so that reverting the 'My account → Workspace' move for staff breaks
// the test immediately.  The rule: price watches are OPERATIONAL for TAs
// (many customer watches) → Workspace; PERSONAL for viewers → My account.

describe("hamburgerSectionsForRole — price-watches section ownership", () => {
  function findSectionContaining(
    role: Parameters<typeof hamburgerSectionsForRole>[0],
    href: string,
  ): string | null | undefined {
    const section = hamburgerSectionsForRole(role).find((s) =>
      s.items.some((i) => i.href === href),
    );
    return section?.heading;
  }

  it("price-watches is NOT in any hamburger section for staff (agent)", () => {
    // Agents manage price watches via the sidebar Workspace section, so the
    // hamburger dropdown must not also list it — that would be a duplicate
    // and signals the move was reverted.
    const hrefs = hamburgerSectionsForRole("agent").flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/settings/price-watches");
  });

  it("price-watches is NOT in any hamburger section for tenant_owner", () => {
    // Same rule as agent: owners access price watches from the sidebar Workspace.
    const hrefs = hamburgerSectionsForRole("tenant_owner").flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/settings/price-watches");
  });

  it("price-watches IS in 'My account' for viewers in the hamburger nav", () => {
    // Viewers have no sidebar Workspace section, so price watches must appear
    // in their hamburger My account section (personal setting).
    expect(findSectionContaining("viewer", "/settings/price-watches")).toBe("My account");
  });

  it("staff My account section in hamburger does NOT contain price-watches", () => {
    // The staff My account section was explicitly stripped of price watches
    // (#962 move to Workspace).  This assertion fails if they're re-added there.
    for (const role of ["agent", "tenant_owner"] as const) {
      const myAccountSection = hamburgerSectionsForRole(role).find(
        (s) => s.heading === "My account",
      );
      if (myAccountSection) {
        const hrefs = myAccountSection.items.map((i) => i.href);
        expect(hrefs).not.toContain("/settings/price-watches");
      }
    }
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
