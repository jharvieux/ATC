// §15.13 — Friendly reminder to a paying-but-inactive tenant.
//
// Sent by compliance-nightly when a tenant has been inactive for 30 / 60 /
// 90 days. Point them at features they're missing + the Help AI.
//
// Recipient: tenants.support_email (the tenant admin).
// Tone: friendly nudge, not a warning. Paying customer — we don't want
//       to make them feel pressured.
//
// Wrapped in BrandedLayout for visual consistency, but the message itself
// is platform-shaped (from "AI Travel Concierge" to the tenant admin).

/* eslint-disable @next/next/no-img-element */

import * as React from "react";
import { BrandedLayout } from "./BrandedLayout";

export type InactivityNudgeLevel = "30d" | "60d" | "90d";

export interface InactivityReminderProps {
  branding: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    slogan?: string | null;
  };
  tenant_legal_name: string;
  tenant_business_address: string;
  recipient_name: string;
  nudge_level: InactivityNudgeLevel;
  days_inactive: number;
  app_url: string;
  help_url: string;
  unsubscribe_url: string;
}

const LEVEL_GREETING: Record<InactivityNudgeLevel, string> = {
  "30d": "We noticed it's been a few weeks",
  "60d": "Checking in — we haven't seen you in a while",
  "90d": "Still here whenever you're ready",
};

const LEVEL_INTRO: Record<InactivityNudgeLevel, string> = {
  "30d":
    "Your subscription is active, but it's been about a month since you last had a chat or worked on a booking. We wanted to make sure you know what's available — there may be features that fit how you work that you haven't tried yet.",
  "60d":
    "It's been two months since your last activity, and your subscription is still active. If something's getting in the way of using the platform, or if there's a feature you wish worked differently, we'd love to know.",
  "90d":
    "Three months without activity, but you're still subscribed. We're not going anywhere — but we'd hate for you to be paying for something that isn't working for you. Have a look at what's available, or chat with our Help AI if anything's unclear.",
};

export function InactivityReminder(props: InactivityReminderProps): React.ReactElement {
  const primary = props.branding.primary_color ?? "#1f2937";
  const accent = props.branding.accent_color ?? "#3b82f6";

  return (
    <BrandedLayout
      branding={props.branding}
      tenant_legal_name={props.tenant_legal_name}
      tenant_business_address={props.tenant_business_address}
      unsubscribe_url={props.unsubscribe_url}
    >
      <h2 style={{ marginTop: 0, color: primary, fontSize: 22 }}>
        {LEVEL_GREETING[props.nudge_level]}, {props.recipient_name}
      </h2>

      <p>{LEVEL_INTRO[props.nudge_level]}</p>

      <p>Features that might be useful:</p>
      <ul style={{ paddingLeft: 20 }}>
        <li><strong>Chat with travellers</strong> — your AI concierge handles inquiries 24/7 and routes the harder questions to you.</li>
        <li><strong>Pre-cruise emails</strong> — automated check-ins at the T-90 / T-30 marks keep your travellers engaged without manual work.</li>
        <li><strong>Group bookings</strong> — invite-link flow with HMAC-signed tokens; you set rates, travellers self-serve into the group.</li>
        <li><strong>Custom branding</strong> — your logo, colours, and domain on every customer touchpoint.</li>
      </ul>

      <p style={{ marginTop: 24 }}>
        <a
          href={props.app_url}
          style={{
            display: "inline-block",
            background: accent,
            color: "white",
            padding: "10px 18px",
            borderRadius: 6,
            textDecoration: "none",
            fontWeight: 600,
            marginRight: 12,
          }}
        >
          Open your dashboard
        </a>
        <a
          href={props.help_url}
          style={{
            display: "inline-block",
            color: accent,
            padding: "10px 0",
            textDecoration: "underline",
          }}
        >
          Get help from our AI →
        </a>
      </p>

      <p style={{ marginTop: 24, color: "#666", fontSize: 13 }}>
        Not interested in these reminders? You can opt out via the unsubscribe link at the bottom of this email.
      </p>
    </BrandedLayout>
  );
}
