"use client";

import * as React from "react";
import Link from "next/link";

export interface TaSidebarLinkProps {
  href: string;
  label: string;
  active: boolean;
  /** Optional lucide-react icon component. When provided, renders before the label. */
  icon?: React.ElementType;
  /** When true, renders icon-only at 48 px width (no label, centered). */
  collapsed?: boolean;
  /** "default" = Admin/Console panels (r6, 6×8, 14px). "workspace" = wider nav rail (r7, 7×10, 13px). */
  variant?: "default" | "workspace";
  onNavigate?: (() => void) | undefined;
}

export function TaSidebarLink({
  href,
  label,
  active,
  icon: Icon,
  collapsed = false,
  variant = "default",
  onNavigate,
}: TaSidebarLinkProps): React.ReactElement {
  const [hovered, setHovered] = React.useState(false);

  const r = variant === "workspace" ? 7 : 6;
  const fs = variant === "workspace" ? 13 : 14;
  const fw = active ? (variant === "workspace" ? 600 : 500) : 400;

  const baseStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    borderRadius: r,
    fontSize: fs,
    fontWeight: fw,
    textDecoration: "none",
    transition: "background 0.12s, color 0.12s",
    // collapsed: icon-only at left edge so it's visible in the 48px window;
    // paddingLeft 16px centers a 16px icon in the 48px collapsed aside.
    padding: collapsed ? "8px 0 8px 16px" : variant === "workspace" ? "7px 10px" : "6px 8px",
    justifyContent: "flex-start",
    gap: 8,
    background: active ? "var(--ta-accent-soft)" : hovered ? "var(--ta-hover)" : "transparent",
    color: active ? "var(--ta-accent)" : hovered ? "var(--ta-text)" : "var(--ta-text-soft)",
    // fill the parent li width so the whole row is clickable
    width: "100%",
    boxSizing: "border-box" as const,
  };

  return (
    <Link
      href={href}
      style={baseStyle}
      title={collapsed ? label : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onNavigate?.()}
    >
      {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden />}
      {!collapsed && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>}
    </Link>
  );
}
