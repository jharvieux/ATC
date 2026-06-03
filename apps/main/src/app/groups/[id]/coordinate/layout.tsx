// §18.11 — Coordinator portal layout with 5-tab navigation.
// Tabs: Overview, Invitees, Edit, Preview Email, Forum.

import * as React from "react";
import Link from "next/link";

const TABS = [
  { slug: "overview", label: "Overview" },
  { slug: "invitees", label: "Invitees" },
  { slug: "edit", label: "Edit" },
  { slug: "preview-email", label: "Preview Email" },
  { slug: "forum", label: "Forum" },
] as const;

type LayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
};

export default async function CoordinateLayout({
  children,
  params,
}: LayoutProps): Promise<React.ReactElement> {
  const { id } = await params;

  return (
    <div className="max-w-[900px] mx-auto px-4 py-6">
      <nav
        className="flex border-b-2 border-border mb-6"
        aria-label="Coordinator tabs"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.slug}
            href={`/groups/${id}/coordinate/${tab.slug}`}
            className="px-4 py-2.5 text-[14px] font-medium text-muted-foreground no-underline border-b-2 border-transparent -mb-0.5 hover:text-foreground hover:border-primary transition-colors"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
