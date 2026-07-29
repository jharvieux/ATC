// WHY: "/" now renders the agency sales page — our pricing, our free-trial
// CTA, and a "bring your own host agency" pitch. On a tenant subdomain that
// page would be shown to the agency's OWN customers, advertising the platform
// (and its prices) underneath the agency's branding. Agency-tier tenants pay
// specifically to remove platform branding.
//
// The gate is a single `if (headerProps.isPlatformDomain)` in page.tsx. This
// test exists so a refactor can't invert or drop it silently.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/site-header/get-site-header-props", () => ({
  getSiteHeaderProps: vi.fn(),
}));

vi.mock("@/lib/branding/request-branding", () => ({
  getRequestTenantBranding: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/components/branding/TenantTheme", () => ({
  TenantTheme: () => null,
}));

vi.mock("@/components/site-header/SiteHeader", () => ({
  SiteHeader: () => <header>site-header</header>,
}));

vi.mock("@/components/landing/AgentCardGrid", () => ({
  AgentCardGrid: () => <div>agent-card-grid</div>,
}));

// Stand-in carrying the two things that must never reach a tenant host.
vi.mock("@/components/marketing/AgencyLanding", () => ({
  AgencyLanding: () => (
    <div>
      <span>Start your free 30-day trial</span>
      <span>$59/mo</span>
    </div>
  ),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn((): never => {
    // Real notFound() throws to interrupt rendering. Match that, or a test
    // could pass while the page carried on and rendered the body anyway.
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  redirect: vi.fn(),
  permanentRedirect: vi.fn(),
}));

import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import HomePage from "@/app/page";
import TravelersPage from "@/app/travelers/page";

const mockGetProps = getSiteHeaderProps as ReturnType<typeof vi.fn>;

async function renderHome(isPlatformDomain: boolean): Promise<string> {
  mockGetProps.mockResolvedValue({
    isPlatformDomain,
    isAuthenticated: false,
    tenantBranding: null,
    role: null,
    avatarUrl: null,
    displayName: null,
  });
  const el = await HomePage();
  return renderToStaticMarkup(el as React.ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("homepage audience gate", () => {
  it("sells to travel agents on the platform domain", async () => {
    const html = await renderHome(true);

    expect(html).toContain("Start your free 30-day trial");
    expect(html).toContain("$59/mo");
  });

  it("emits the platform's schema.org graph only on the platform domain", async () => {
    // The graph names AI Travel Concierge as the publisher — correct at the
    // apex, wrong under an agency's own domain.
    expect(await renderHome(true)).toContain("schema.org");
    expect(await renderHome(false)).not.toContain("schema.org");
  });

  it("never shows platform pricing on a tenant subdomain", async () => {
    const html = await renderHome(false);

    expect(html).not.toContain("Start your free 30-day trial");
    expect(html).not.toContain("$59/mo");
    // The tenant still gets its own hero and the agent grid.
    expect(html).toContain("agent-card-grid");
  });
});

// Same white-label reasoning as the homepage gate: /travelers is the
// platform's own consumer funnel. Under an agency's domain it would invite
// that agency's clients to "Log in" to the platform and browse platform
// agents, competing with the agency on its own site.
describe("/travelers audience gate", () => {
  it("renders the traveller funnel on the platform domain", async () => {
    mockGetProps.mockResolvedValue({
      isPlatformDomain: true,
      isAuthenticated: false,
      tenantBranding: null,
      role: null,
      avatarUrl: null,
      displayName: null,
    });

    const html = renderToStaticMarkup(
      (await TravelersPage()) as React.ReactElement,
    );

    expect(html).toContain("Meet your AI travel agents");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("404s on a tenant subdomain instead of rendering", async () => {
    mockGetProps.mockResolvedValue({
      isPlatformDomain: false,
      isAuthenticated: false,
      tenantBranding: null,
      role: null,
      avatarUrl: null,
      displayName: null,
    });

    await expect(TravelersPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});
