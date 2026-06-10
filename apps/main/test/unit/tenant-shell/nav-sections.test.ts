// #962 — role gating for the tenant landing shell's left nav.
//
// Intent: the nav must never show a link the role can't use. Viewers are
// end customers — staff surfaces (Concierge, CRM) and owner surfaces
// (Settings) would 403 via assertPermission, so showing them is a dead
// link. Conversely every role must keep the support-chat home entry.

import { describe, it, expect } from "vitest";
import { navSectionsForRole, TENANT_NAV_SECTIONS } from "@/components/tenant-shell/nav-sections";

function hrefsFor(role: "tenant_owner" | "agent" | "viewer"): string[] {
  return navSectionsForRole(role).flatMap((s) => s.items.map((i) => i.href));
}

describe("navSectionsForRole", () => {
  it("every role gets the support-chat home entry", () => {
    for (const role of ["tenant_owner", "agent", "viewer"] as const) {
      expect(hrefsFor(role)).toContain("/");
    }
  });

  it("viewers see no staff or owner surfaces (no dead links)", () => {
    const hrefs = hrefsFor("viewer");
    expect(hrefs).not.toContain("/concierge");
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
    expect(hrefs).toContain("/concierge");
    expect(hrefs).toContain("/crm/contacts");
    expect(hrefs).not.toContain("/settings");
    expect(hrefs).not.toContain("/settings/usage");
  });

  it("owners see every section", () => {
    expect(navSectionsForRole("tenant_owner")).toHaveLength(
      TENANT_NAV_SECTIONS.length,
    );
    expect(hrefsFor("tenant_owner")).toContain("/settings");
  });
});
