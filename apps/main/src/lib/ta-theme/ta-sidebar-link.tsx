"use client";

import * as React from "react";
import Link from "next/link";

export interface TaSidebarLinkProps {
  href: string;
  label: string;
  active: boolean;
  /** "default" = Admin/Console panels (r6, 6×8, 14px). "workspace" = wider nav rail (r7, 7×10, 13px). */
  variant?: "default" | "workspace";
  onNavigate?: (() => void) | undefined;
}

export function TaSidebarLink({
  href,
  label,
  active,
  variant = "default",
  onNavigate,
}: TaSidebarLinkProps): React.ReactElement {
  const [hovered, setHovered] = React.useState(false);

  const r = variant === "workspace" ? 7 : 6;
  const p = variant === "workspace" ? "7px 10px" : "6px 8px";
  const fs = variant === "workspace" ? 13 : 14;

  const style: React.CSSProperties = active
    ? {
        display: "block",
        borderRadius: r,
        padding: p,
        fontSize: fs,
        fontWeight: variant === "workspace" ? 600 : 500,
        background: "var(--ta-accent-soft)",
        color: "var(--ta-accent)",
        textDecoration: "none",
        transition: "background 0.12s, color 0.12s",
      }
    : {
        display: "block",
        borderRadius: r,
        padding: p,
        fontSize: fs,
        fontWeight: 400,
        background: hovered ? "var(--ta-hover)" : "transparent",
        color: hovered ? "var(--ta-text)" : "var(--ta-text-soft)",
        textDecoration: "none",
        transition: "background 0.12s, color 0.12s",
      };

  return (
    <Link
      href={href}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onNavigate?.()}
    >
      {label}
    </Link>
  );
}
