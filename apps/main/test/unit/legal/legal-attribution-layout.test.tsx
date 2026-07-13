// §16.7.1 — the /legal layout renders the always-on LegalPageAttribution
// banner above every legal page, naming the resolved tenant as the
// responsible party (platform legal entity on the platform domain).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const { getRequestTenantBranding } = vi.hoisted(() => ({
  getRequestTenantBranding: vi.fn(),
}));
vi.mock("@/lib/branding/request-branding", () => ({ getRequestTenantBranding }));

import LegalLayout from "@/app/legal/layout";

async function render(children: React.ReactNode) {
  const el = await LegalLayout({ children });
  return renderToStaticMarkup(el);
}

describe("LegalLayout attribution (§16.7.1)", () => {
  beforeEach(() => getRequestTenantBranding.mockReset());

  it("names the resolved tenant as the operating Travel Agency", async () => {
    getRequestTenantBranding.mockResolvedValue({ display_name: "Acme Cruises" });
    const html = await render(createElement("p", null, "body"));
    expect(html).toContain("operated by Acme Cruises");
    expect(html).toContain("solely responsible");
    expect(html).toContain("body");
  });

  it("falls back to the platform entity on the platform domain (null branding)", async () => {
    getRequestTenantBranding.mockResolvedValue(null);
    const html = await render(createElement("p", null, "body"));
    expect(html).toContain("operated by AI Travel Concierge");
  });
});
