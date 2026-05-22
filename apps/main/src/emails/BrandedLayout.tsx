// §16.8 — Branded email layout.
// Email clients don't support CSS custom properties, so all colors are inlined.
// This component is rendered to HTML by the email-send adapter (Resend).
//
// React Email is not yet installed; this returns a JSX tree that can be
// serialized via ReactDOMServer.renderToStaticMarkup OR a string template
// fallback used by the email-send helper.
//
// The Next.js `<Head />` / `<Image />` rules don't apply to email templates;
// email clients require raw <head> and <img> tags.
/* eslint-disable @next/next/no-head-element, @next/next/no-img-element */

import * as React from "react";

export interface BrandedLayoutProps {
  branding: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    slogan?: string | null;
  };
  tenant_legal_name: string;
  tenant_business_address: string;
  unsubscribe_url: string;
  children: React.ReactNode;
}

const DEFAULT_PRIMARY = "#1f2937";
const DEFAULT_ACCENT = "#3b82f6";

export function BrandedLayout(props: BrandedLayoutProps): React.ReactElement {
  const primary = props.branding.primary_color ?? DEFAULT_PRIMARY;
  const accent = props.branding.accent_color ?? DEFAULT_ACCENT;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{props.tenant_legal_name}</title>
      </head>
      <body style={{ margin: 0, fontFamily: "Arial, sans-serif", backgroundColor: "#f6f6f6", color: "#222" }}>
        <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f6f6f6" }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: "24px 0" }}>
                <table role="presentation" width="600" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#ffffff", borderRadius: 8, overflow: "hidden", maxWidth: 600 }}>
                  <tbody>
                    {/* Header */}
                    <tr>
                      <td style={{ padding: 24, borderBottom: `4px solid ${accent}` }}>
                        {props.branding.logo_url ? (
                          <img src={props.branding.logo_url} alt={props.tenant_legal_name} style={{ maxHeight: 60, display: "block" }} />
                        ) : (
                          <h1 style={{ margin: 0, color: primary, fontSize: 22 }}>{props.tenant_legal_name}</h1>
                        )}
                        {props.branding.slogan ? (
                          <p style={{ margin: "8px 0 0 0", color: "#666", fontSize: 14 }}>{props.branding.slogan}</p>
                        ) : null}
                      </td>
                    </tr>
                    {/* Body */}
                    <tr>
                      <td style={{ padding: "24px 32px", lineHeight: 1.6, fontSize: 15 }}>{props.children}</td>
                    </tr>
                    {/* Footer (CAN-SPAM: legal name + address + unsubscribe) */}
                    <tr>
                      <td style={{ padding: "16px 32px", backgroundColor: "#fafafa", borderTop: "1px solid #eee", fontSize: 12, color: "#888" }}>
                        <p style={{ margin: 0 }}>
                          {props.tenant_legal_name} · {props.tenant_business_address}
                        </p>
                        <p style={{ margin: "8px 0 0 0" }}>
                          <a href={props.unsubscribe_url} style={{ color: "#888" }}>Unsubscribe</a>
                          {" · "}
                          <span>Powered by AI Travel Concierge</span>
                        </p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}
