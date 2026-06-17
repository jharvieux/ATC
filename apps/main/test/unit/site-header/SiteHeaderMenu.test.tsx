// Role-gating wiring for SiteHeaderMenu (#1199).
//
// WHY: before #1199 the site-header hamburger had no role awareness — it showed
// generic Home/Settings links for ALL authenticated users, hiding Dashboard and
// Admin Console from tenant_owners on CRM pages. This test guards the prop
// threading so a future refactor can't silently drop the role.
//
// What's covered:
//   - tenant_owner sees Dashboard ("/") + Admin Console ("/settings")
//   - agent sees Dashboard ("/") but NOT Admin Console ("/settings")
//   - viewer does NOT see Dashboard ("/") as a nav link
//   - null role falls back to generic items (no role-specific nav)
//   - unauthenticated users see Sign up, not role nav

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Radix dropdown is browser-only; replace with passthrough wrappers so
// renderToStaticMarkup sees the menu items without needing a DOM.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
    onSelect?: () => void;
  }) => (asChild ? <>{children}</> : <div>{children}</div>),
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("lucide-react", () => ({
  Menu: () => <span data-testid="menu-icon" />,
}));

vi.mock("@/lib/auth/perform-signout", () => ({
  performSignout: vi.fn(),
}));

import { SiteHeaderMenu } from "@/components/site-header/SiteHeaderMenu";

function render(props: React.ComponentProps<typeof SiteHeaderMenu>): string {
  return renderToStaticMarkup(<SiteHeaderMenu {...props} />);
}

describe("SiteHeaderMenu — role-aware nav wiring (#1199)", () => {
  it("tenant_owner sees Dashboard and Admin Console links", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "tenant_owner",
    });
    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Admin Console");
  });

  it("agent sees Dashboard but not Admin Console", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "agent",
    });
    expect(html).toContain('href="/"');
    expect(html).toContain("Dashboard");
    // Admin Console is owner-only
    expect(html).not.toContain("Admin Console");
  });

  it("viewer does not see Dashboard or Admin Console but does see self-service account links", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "viewer",
    });
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain("Admin Console");
    // Viewers are end customers — they get account self-service (conversations,
    // price-watches, privacy), not staff-only surfaces.
    expect(html).toContain('href="/settings/conversations"');
  });

  it("null role shows generic fallback items instead of role nav", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: null,
    });
    // Generic fallback: Home + Concierge (tenant subdomain) + Settings
    expect(html).not.toContain("Dashboard");
    expect(html).toContain('href="/"');
  });

  it("unauthenticated user sees Sign up and no role nav", () => {
    const html = render({
      isPlatformDomain: true,
      isAuthenticated: false,
    });
    expect(html).toContain("Sign up");
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain("Admin Console");
  });
});
