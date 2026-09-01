// Email clients require raw HTML elements and inline styles; Next's Head/Image
// abstractions would produce markup that many inboxes cannot render reliably.
/* eslint-disable @next/next/no-head-element, @next/next/no-img-element */

import * as React from "react";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";

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
  const businessAddress = formatMailingAddress(props.tenant_business_address);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{props.tenant_legal_name}</title>
      </head>
      <body style={{ margin: 0, backgroundColor: "#edf2f4", color: "#243447", fontFamily: "Arial, sans-serif" }}>
        <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#edf2f4" }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: "32px 12px" }}>
                <table role="presentation" width="600" cellSpacing={0} cellPadding={0} style={{ width: "100%", maxWidth: 600, backgroundColor: "#ffffff" }}>
                  <tbody>
                    <tr>
                      <td style={{ height: 6, backgroundColor: accent, fontSize: 1, lineHeight: "1px" }}>&nbsp;</td>
                    </tr>
                    <tr>
                      <td style={{ padding: "26px 32px 22px 32px", borderBottom: "1px solid #dce5ea" }}>
                        {props.branding.logo_url ? (
                          <img src={props.branding.logo_url} alt={props.tenant_legal_name} style={{ display: "block", maxHeight: 56, maxWidth: 230 }} />
                        ) : (
                          <p style={{ margin: 0, color: primary, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{props.tenant_legal_name}</p>
                        )}
                        {props.branding.slogan ? (
                          <p style={{ margin: "8px 0 0 0", color: "#64748b", fontSize: 12, letterSpacing: 0.4, lineHeight: 1.5 }}>{props.branding.slogan}</p>
                        ) : null}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ padding: "30px 32px 34px 32px", fontSize: 15, lineHeight: 1.65 }}>{props.children}</td>
                    </tr>
                    <tr>
                      <td style={{ padding: "20px 32px 24px 32px", backgroundColor: "#f7fafc", borderTop: "1px solid #dce5ea", color: "#64748b", fontSize: 12, lineHeight: 1.55 }}>
                        <p style={{ margin: 0 }}>
                          {props.tenant_legal_name} · {businessAddress}
                        </p>
                        <p style={{ margin: "8px 0 0 0" }}>
                          <a href={props.unsubscribe_url} style={{ color: "#526577", textDecoration: "underline" }}>Unsubscribe</a>
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
