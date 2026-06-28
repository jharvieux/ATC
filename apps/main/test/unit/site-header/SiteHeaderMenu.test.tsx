// Role-gating wiring for SiteHeaderMenu (#1199).
//
// WHY: before #1199 the site-header hamburger had no role awareness — it showed
// generic Home/Settings links for ALL authenticated users, hiding Dashboard and
// Admin Console from tenant_owners on CRM pages. This test guards the prop
// threading so a future refactor can't silently drop the role.
//
// What's covered:
//   - tenant_owner sees TA Chat ("/concierge") + Admin Console ("/settings")
//   - agent sees TA Chat ("/concierge") but NOT Admin Console ("/settings")
//   - viewer does NOT see TA Chat or Dashboard as a nav link
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

// WHY: the trigger icon differs based on auth + avatar state; a refactor
// that silently drops the avatar/initials branches would regress UX without
// a test failure.
describe("SiteHeaderMenu — trigger icon state (#1302)", () => {
  it("shows avatar img when authenticated with avatarUrl", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "agent",
      avatarUrl: "https://example.com/avatar.jpg",
      displayName: "Jane Smith",
    });
    expect(html).toContain('src="https://example.com/avatar.jpg"');
    expect(html).not.toContain('data-testid="menu-icon"');
  });

  it("shows initials when authenticated with displayName but no avatarUrl", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "agent",
      avatarUrl: null,
      displayName: "Jane Smith",
    });
    expect(html).toContain(">J<");
    expect(html).not.toContain('data-testid="menu-icon"');
  });

  it("falls back to menu icon when authenticated but no avatarUrl or displayName", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "agent",
      avatarUrl: null,
      displayName: null,
    });
    expect(html).toContain('data-testid="menu-icon"');
  });

  it("shows menu icon when unauthenticated regardless of avatarUrl", () => {
    const html = render({
      isPlatformDomain: true,
      isAuthenticated: false,
      avatarUrl: "https://example.com/avatar.jpg",
    });
    expect(html).not.toContain("example.com/avatar.jpg");
    expect(html).toContain('data-testid="menu-icon"');
  });
});

describe("SiteHeaderMenu — role-aware nav wiring (#1199)", () => {
  it("tenant_owner sees TA Chat and Admin Console links", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "tenant_owner",
    });
    expect(html).toContain('href="/concierge"');
    expect(html).toContain("TA Chat");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Admin Console");
  });

  it("agent sees TA Chat but not Admin Console", () => {
    const html = render({
      isPlatformDomain: false,
      isAuthenticated: true,
      role: "agent",
    });
    expect(html).toContain('href="/concierge"');
    expect(html).toContain("TA Chat");
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
