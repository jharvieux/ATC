// Layout shell for every page in the (admin) route group. Two columns:
// left = AdminSidebar (collapsible groupings of admin pages), right =
// page content. Includes a slim top bar with logo + sidebar toggle so
// the operator can reclaim horizontal space.
//
// Client component for the toggle state. Auth is still enforced
// upstream in (admin)/layout.tsx — this shell is rendered only AFTER
// the platform-admin gate passes.

"use client";

import * as React from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Logo } from "@/components/branding/Logo";
import { LogoMark } from "@/components/branding/LogoMark";
import { AdminSidebar } from "./AdminSidebar";

export function AdminShell({
  children,
}: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  const [open, setOpen] = React.useState(true);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Hide sidebar" : "Show sidebar"}
            className="rounded-md p-1.5 hover:bg-accent"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/admin" aria-label="Admin home" className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <Logo height={28} />
            </span>
            <span className="sm:hidden">
              <LogoMark size={28} />
            </span>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Admin
            </span>
          </Link>
        </div>
      </header>
      <div className="flex flex-1">
        <AdminSidebar open={open} />
        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
