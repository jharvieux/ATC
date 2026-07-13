// BP34 §34.2.4 — the CRM layout mounts GmailHealthBanner for Gmail-capable
// tiers and withholds it for BYO Research (which has no Gmail integration).
// This is the newly-reachable behavior: before this wiring the banner was
// never mounted anywhere.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const { getRequestTenantTierCode } = vi.hoisted(() => ({
  getRequestTenantTierCode: vi.fn(),
}));
vi.mock("@/lib/tenancy/request-tenant-tier", () => ({ getRequestTenantTierCode }));
// Render the banner as an identifiable sentinel so we can assert mount/withhold
// without simulating the client-side fetch.
vi.mock("@/components/integrations/GmailHealthBanner", () => ({
  GmailHealthBanner: () => createElement("div", { "data-testid": "gmail-banner" }),
}));

import CrmLayout from "@/app/(tenant)/crm/layout";

async function render() {
  const el = await CrmLayout({ children: createElement("p", null, "crm") });
  return renderToStaticMarkup(el);
}

describe("CrmLayout Gmail banner gating (§34.2.4)", () => {
  beforeEach(() => getRequestTenantTierCode.mockReset());

  it("mounts the banner for a Gmail-capable tier", async () => {
    getRequestTenantTierCode.mockResolvedValue("byo_agency");
    const html = await render();
    expect(html).toContain("gmail-banner");
    expect(html).toContain("crm");
  });

  it("withholds the banner for byo_research", async () => {
    getRequestTenantTierCode.mockResolvedValue("byo_research");
    const html = await render();
    expect(html).not.toContain("gmail-banner");
    expect(html).toContain("crm");
  });

  it("withholds the banner when the tier can't be resolved", async () => {
    getRequestTenantTierCode.mockResolvedValue(null);
    const html = await render();
    expect(html).not.toContain("gmail-banner");
  });
});
