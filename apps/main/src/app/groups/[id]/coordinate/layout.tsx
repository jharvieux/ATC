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
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif" }}>
      <nav
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "2px solid #e5e7eb",
          marginBottom: 24,
        }}
        aria-label="Coordinator tabs"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.slug}
            href={`/groups/${id}/coordinate/${tab.slug}`}
            style={{
              padding: "10px 18px",
              fontSize: 14,
              fontWeight: 500,
              color: "#374151",
              textDecoration: "none",
              borderBottom: "2px solid transparent",
              marginBottom: -2,
            }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
