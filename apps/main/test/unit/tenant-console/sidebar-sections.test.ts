// #962 follow-up — role gating for the tenant Admin Console sidebar.
//
// Intent: the console is owner-scoped today. Every page inside it carries
// its own assertPermission gate, so a sidebar link that a non-owner can't
// actually open is a dead link — filterConsoleNavForRole must hide it.
// This mirrors nav-sections.test.ts, which guards the same property for
// the dashboard hamburger.

import { describe, it, expect } from "vitest";
import {
  CONSOLE_NAV_SECTIONS,
  filterConsoleNavForRole,
} from "@/components/tenant-console/sidebar-sections";

type Role = "tenant_owner" | "agent" | "viewer";

function hrefsFor(role: Role): string[] {
  return filterConsoleNavForRole(role).flatMap((s) => s.items.map((i) => i.href));
}

describe("filterConsoleNavForRole", () => {
  it("owners see every console section and item", () => {
    const sections = filterConsoleNavForRole("tenant_owner");
    expect(sections).toHaveLength(CONSOLE_NAV_SECTIONS.length);
    // Spot-check that owner-only admin surfaces are present.
    const hrefs = hrefsFor("tenant_owner");
    expect(hrefs).toContain("/settings/billing");
    expect(hrefs).toContain("/settings/usage");
    expect(hrefs).toContain("/tenant-admin/safety");
  });

  it("non-owners get nothing — the whole console is owner-scoped (no dead links)", () => {
    // agents and viewers would 403 on every console page, so the sidebar
    // must be empty for them rather than show links they can't open.
    expect(filterConsoleNavForRole("agent")).toHaveLength(0);
    expect(filterConsoleNavForRole("viewer")).toHaveLength(0);
  });

  it("drops a section entirely when role-filtering empties its items", () => {
    // Defends the empty-section guard: a section whose items all filter
    // out must not render as a heading with no links under it.
    for (const section of filterConsoleNavForRole("tenant_owner")) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});
