"use client";

// §18.11 — Coordinator portal cruise-theme chrome: header (tenant logo/name +
// theme toggle) and tab nav, wrapping the server-rendered tab body.
//
// Lives in its own client component (not inlined in layout.tsx) because
// useCruiseTheme/quicksand need "use client", while the layout itself must
// stay an async server component to fetch tenant branding via
// getRequestTenantBranding() (reads request headers). Mirrors
// GroupInviteView.tsx's role on the customer-facing invite page.

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCruiseTheme } from "@/lib/group-invite/use-cruise-theme";
import { quicksand } from "@/lib/fonts/quicksand";
import { CruiseThemeToggle } from "@/components/group-invite/CruiseThemeToggle";

const TABS = [
  { slug: "overview", label: "Overview" },
  { slug: "invitees", label: "Invitees" },
  { slug: "edit", label: "Edit" },
  { slug: "preview-email", label: "Preview Email" },
  { slug: "forum", label: "Forum" },
] as const;

interface CoordinatorShellProps {
  groupId: string;
  tenantDisplayName: string | null;
  tenantLogoUrl: string | null;
  children: React.ReactNode;
}

export function CoordinatorShell({ groupId, tenantDisplayName, tenantLogoUrl, children }: CoordinatorShellProps) {
  const [theme] = useCruiseTheme();
  const pathname = usePathname();
  const activeSlug = TABS.find((tab) => pathname?.endsWith(`/${tab.slug}`))?.slug ?? "overview";

  return (
    <div data-cruise-theme={theme} className={`${quicksand.variable} min-h-screen bg-[var(--cruise-bg)] text-[var(--cruise-text)]`}>
      <div className="flex items-center justify-between border-b border-[var(--cruise-border)] bg-[var(--cruise-surface)] px-6 py-4 sm:px-10">
        <div className="flex items-center gap-2.5">
          {tenantLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tenantLogoUrl} alt="" className="h-[30px] w-[30px] rounded-[9px] object-contain" />
          ) : (
            <div
              className="h-[30px] w-[30px] rounded-[9px]"
              style={{ background: "linear-gradient(135deg,var(--cruise-accent),var(--cruise-sun))" }}
            />
          )}
          <span className="font-[family-name:var(--font-quicksand)] text-[15px] font-bold tracking-[.01em] text-[var(--cruise-text)]">
            {tenantDisplayName ?? "Group Coordinator"}
          </span>
        </div>
        <CruiseThemeToggle />
      </div>

      <nav
        className="flex gap-1.5 overflow-x-auto border-b border-[var(--cruise-border)] bg-[var(--cruise-surface)] px-6 py-3 sm:px-10"
        aria-label="Coordinator tabs"
      >
        {TABS.map((tab) => {
          const isActive = tab.slug === activeSlug;
          return (
            <Link
              key={tab.slug}
              href={`/groups/${groupId}/coordinate/${tab.slug}`}
              aria-current={isActive ? "page" : undefined}
              className={`whitespace-nowrap rounded-[var(--cruise-radius-pill)] px-4 py-2 text-[13px] font-semibold transition-colors ${
                isActive
                  ? "bg-[var(--cruise-accent)] text-white"
                  : "text-[var(--cruise-text-muted)] hover:bg-[var(--cruise-bg)] hover:text-[var(--cruise-text)]"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <main className="mx-auto max-w-[960px] px-6 py-8 sm:px-10">{children}</main>
    </div>
  );
}
