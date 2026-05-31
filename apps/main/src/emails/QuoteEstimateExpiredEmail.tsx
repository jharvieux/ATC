// §23.10.1 — Customer-facing email for an expired ESTIMATE quote.
//
// Sent by quote-estimate-expiry-sweep when a quote transitions sent→expired.
// The "Request fresh quote" CTA links to /q/[token] where the customer can
// interact with their agent via the embedded chat panel.

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface QuoteEstimateExpiredEmailProps {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  // Displayed in the subject line / heading if present.
  cruise_label?: string | null;
  // Full URL to /q/[token]; null if the quote has no customer_access_token.
  refresh_url: string | null;
  validity_days: number;
}

export function QuoteEstimateExpiredEmail(
  props: QuoteEstimateExpiredEmailProps,
): React.ReactElement {
  const accent = props.layout.branding.accent_color ?? "#3b82f6";
  const primary = props.layout.branding.primary_color ?? "#1f2937";
  const cruiseLabel = props.cruise_label ?? "your cruise";

  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: primary, marginTop: 0 }}>
        Your estimate for {cruiseLabel} has expired, {props.customer_name}
      </h2>

      <p>
        Cruise pricing can shift quickly, so we put a{" "}
        <strong>{props.validity_days}-day window</strong> on estimate quotes to
        keep things accurate. Your estimate has passed that window and is no
        longer valid.
      </p>

      <p>
        The good news: getting a fresh quote is quick. Just click below and
        your travel agent will be ready to put together updated pricing for
        you.
      </p>

      {props.refresh_url ? (
        <p style={{ marginTop: 24 }}>
          <a
            href={props.refresh_url}
            style={{
              display: "inline-block",
              background: accent,
              color: "#fff",
              padding: "12px 24px",
              borderRadius: 6,
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Request a fresh quote →
          </a>
        </p>
      ) : (
        <p>
          Reply to this email or contact your travel agent directly to request
          updated pricing.
        </p>
      )}

      <p style={{ marginTop: 24, color: "#6b7280", fontSize: 13 }}>
        If you have already booked or no longer need this quote, you can safely
        ignore this message.
      </p>
    </BrandedLayout>
  );
}
