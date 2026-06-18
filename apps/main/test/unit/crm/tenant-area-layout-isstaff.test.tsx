// WHY: layout.tsx:39 gates ConversationRailDrawer on isStaff
// (tenant_owner | agent). A viewer or unauthenticated user must never receive
// the component. This test guards the gate so a future refactor can't silently
// drop the condition or widen it to include viewer.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserRole } from "@/lib/auth/permission-grants";

// --- stubs ---

vi.mock("@/components/site-header/get-site-header-props", () => ({
  getSiteHeaderProps: vi.fn(),
}));

vi.mock("@/lib/branding/request-branding", () => ({
  getRequestTenantBranding: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/components/branding/TenantTheme", () => ({
  TenantTheme: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/branding-setup-banner/BrandingSetupBannerServer", () => ({
  BrandingSetupBannerServer: () => null,
}));

// SiteHeader must forward leftSlot so the gate is observable in output.
vi.mock("@/components/site-header/SiteHeader", () => ({
  SiteHeader: ({ leftSlot }: { leftSlot?: React.ReactNode }) => (
    <header>{leftSlot ?? null}</header>
  ),
}));

// ConversationRailDrawer renders a toggle button with a known aria-label.
vi.mock("@/components/crm/ConversationRailDrawer", () => ({
  ConversationRailDrawer: () => (
    <button type="button" aria-label="Toggle conversation history">rail</button>
  ),
}));

import { getSiteHeaderProps } from "@/components/site-header/get-site-header-props";
import TenantAreaLayout from "@/app/(tenant)/layout";

const mockGetProps = getSiteHeaderProps as ReturnType<typeof vi.fn>;

async function renderLayout(role: UserRole | null): Promise<string> {
  mockGetProps.mockResolvedValue({
    role,
    isAuthenticated: role !== null,
    isPlatformDomain: false,
    tenantBranding: null,
  });
  const el = await TenantAreaLayout({ children: <span>child</span> });
  return renderToStaticMarkup(el as React.ReactElement);
}

const DRAWER_MARKER = "Toggle conversation history";

describe("TenantAreaLayout isStaff render gate", () => {
  it("tenant_owner sees the ConversationRailDrawer", async () => {
    const html = await renderLayout("tenant_owner");
    expect(html).toContain(DRAWER_MARKER);
  });

  it("agent sees the ConversationRailDrawer", async () => {
    const html = await renderLayout("agent");
    expect(html).toContain(DRAWER_MARKER);
  });

  it("viewer does NOT see the ConversationRailDrawer", async () => {
    const html = await renderLayout("viewer");
    expect(html).not.toContain(DRAWER_MARKER);
  });

  it("unauthenticated (null role) does NOT see the ConversationRailDrawer", async () => {
    const html = await renderLayout(null);
    expect(html).not.toContain(DRAWER_MARKER);
  });
});
