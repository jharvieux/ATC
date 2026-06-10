// #975 — Shared building blocks for the marketing-grade default templates.
// Email-client-safe by construction: tables + inline styles only (matches
// BrandedLayout). Every part takes the tenant accent/primary colors as props
// so branded tenants get branded sections, not hardcoded platform blue.

import * as React from "react";

export const DEFAULT_PRIMARY = "#1f2937";
export const DEFAULT_ACCENT = "#3b82f6";

/** Eyebrow-style section heading: small-caps label over an accent rule. */
export function SectionHeading(props: { accent: string; children: React.ReactNode }): React.ReactElement {
  return (
    <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "28px 0 12px 0" }}>
      <tbody>
        <tr>
          <td
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: props.accent,
              paddingBottom: 6,
              borderBottom: "2px solid #e5e7eb",
            }}
          >
            {props.children}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Centered table-based CTA button (anchor-styled <td> for client safety). */
export function CtaButton(props: { href: string; accent: string; children: React.ReactNode }): React.ReactElement {
  return (
    <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "28px 0" }}>
      <tbody>
        <tr>
          <td align="center">
            <table role="presentation" cellSpacing={0} cellPadding={0}>
              <tbody>
                <tr>
                  <td style={{ borderRadius: 8, backgroundColor: props.accent }}>
                    <a
                      href={props.href}
                      style={{
                        display: "inline-block",
                        padding: "14px 32px",
                        color: "#ffffff",
                        textDecoration: "none",
                        fontWeight: 700,
                        fontSize: 15,
                      }}
                    >
                      {props.children}
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Countdown pill shown at the top of the pre-cruise sequence. */
export function CountdownBadge(props: { accent: string; children: React.ReactNode }): React.ReactElement {
  return (
    <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ marginBottom: 16 }}>
      <tbody>
        <tr>
          <td align="center">
            <span
              style={{
                display: "inline-block",
                padding: "6px 18px",
                borderRadius: 999,
                backgroundColor: "#eff6ff",
                border: `1px solid ${props.accent}`,
                color: props.accent,
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: "uppercase",
              }}
            >
              {props.children}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Checklist-style item rows inside a soft card — replaces bare <ul>. */
export function ChecklistCard(props: { items: string[]; accent: string }): React.ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <table
      role="presentation"
      width="100%"
      cellSpacing={0}
      cellPadding={0}
      style={{ backgroundColor: "#f9fafb", borderRadius: 8, margin: "4px 0 8px 0" }}
    >
      <tbody>
        {props.items.map((item, i) => (
          <tr key={i}>
            <td
              width={32}
              style={{
                padding: i === 0 ? "14px 0 6px 16px" : i === props.items.length - 1 ? "6px 0 14px 16px" : "6px 0 6px 16px",
                color: props.accent,
                fontWeight: 700,
                verticalAlign: "top",
              }}
            >
              ✓
            </td>
            <td
              style={{
                padding: i === 0 ? "14px 16px 6px 0" : i === props.items.length - 1 ? "6px 16px 14px 0" : "6px 16px 6px 0",
                color: "#374151",
                lineHeight: 1.6,
              }}
            >
              {item}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
