// §23.10.1 — Customer-facing email for an expired ESTIMATE quote.
// #975 — marketing-grade layout: eyebrow section heading + shared CTA button.
//
// Sent by quote-estimate-expiry-sweep when a quote transitions sent→expired.
// The "Request fresh quote" CTA links to /q/[token] where the customer can
// interact with their agent via the embedded chat panel.

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { SectionHeading, CtaButton, DEFAULT_PRIMARY, DEFAULT_ACCENT } from "./EmailParts";

export interface QuoteEstimateExpiredEmailProps {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  cruise_label?: string | null;
  // Full URL to /q/[token]; null if the quote has no customer_access_token.
  refresh_url: string | null;
  validity_days: number;
}

export function QuoteEstimateExpiredEmail(
  props: QuoteEstimateExpiredEmailProps,
): React.ReactElement {
  const accent = props.layout.branding.accent_color ?? DEFAULT_ACCENT;
  const primary = props.layout.branding.primary_color ?? DEFAULT_PRIMARY;
  const cruiseLabel = props.cruise_label ?? "your cruise";

  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: primary, margin: "0 0 16px 0", fontSize: 24 }}>
        Your estimate for {cruiseLabel} has expired, {props.customer_name}
      </h2>

      <p style={{ lineHeight: 1.7 }}>
        Cruise pricing can shift quickly, so we put a{" "}
        <strong>{props.validity_days}-day window</strong> on estimate quotes to
        keep things accurate. Your estimate has passed that window and is no
        longer valid.
      </p>

      <SectionHeading accent={accent}>What Happens Next</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>
        The good news: getting a fresh quote is quick. Just click below and
        your travel agent will be ready to put together updated pricing for
        you.
      </p>

      {props.refresh_url ? (
        <CtaButton href={props.refresh_url} accent={accent}>
          Request a fresh quote →
        </CtaButton>
      ) : (
        <p style={{ lineHeight: 1.7 }}>
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
