// Link-wiring guard for AdminHeaderMenu (#1435).
//
// WHY: AdminHeaderMenu is the only cross-area navigation for a user who holds
// both platform-admin and tenant-admin roles. A future refactor that silently
// drops one of the three hrefs (/settings, /crm/contacts, /admin) or the
// sign-out item would leave that user stranded with no visible recovery path.
// This test encodes that contract so breakage is caught at CI, not in prod.

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: React.PropsWithChildren) => <button>{children}</button>,
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

import { AdminHeaderMenu } from "@/components/admin-shell/AdminHeaderMenu";

describe("AdminHeaderMenu — cross-area link wiring (#1435)", () => {
  const html = renderToStaticMarkup(<AdminHeaderMenu />);

  it("renders Tenant Console link to /settings", () => {
    expect(html).toContain('href="/settings"');
  });

  it("renders CRM link to /crm/contacts", () => {
    expect(html).toContain('href="/crm/contacts"');
  });

  it("renders Platform Admin link to /admin", () => {
    expect(html).toContain('href="/admin"');
  });

  it("renders a Sign out item", () => {
    expect(html).toContain("Sign out");
  });
});
