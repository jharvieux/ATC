// #975 — Group invitation reminder email template.
// Replaces the bare inline-HTML reminder (which shipped with no branding and
// no CAN-SPAM footer) with a BrandedLayout email: hero image, trip-details
// table, and the coordinator's message styled as a letter — visually
// consistent with GroupInvitation.
/* eslint-disable @next/next/no-img-element */

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { DEFAULT_PRIMARY, DEFAULT_ACCENT, CtaButton } from "./EmailParts";

export interface GroupReminderProps {
  layout: Omit<BrandedLayoutProps, "children">;
  invitee_name: string | null;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  coordinator_message: string | null;
  hero_image_url: string | null;
  invite_url?: string;
}

export function GroupReminder(props: GroupReminderProps): React.ReactElement {
  const primary = props.layout.branding.primary_color ?? DEFAULT_PRIMARY;
  const accent = props.layout.branding.accent_color ?? DEFAULT_ACCENT;
  const greeting = props.invitee_name ? `Hi ${props.invitee_name}!` : "Hi there!";
  const sailingDate = Number.isNaN(Date.parse(props.sailing_date))
    ? props.sailing_date
    : new Date(props.sailing_date).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

  return (
    <BrandedLayout {...props.layout}>
      {props.hero_image_url && (
        <div style={{ margin: "-24px -32px 24px", overflow: "hidden" }}>
          <img
            src={props.hero_image_url}
            alt={`${props.ship_name} group cruise`}
            style={{ width: "100%", maxHeight: 240, objectFit: "cover", display: "block" }}
          />
        </div>
      )}

      <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{greeting}</p>
      <p style={{ color: "#374151", marginBottom: 24, lineHeight: 1.7 }}>
        Friendly reminder — your group cruise invitation is still waiting for your
        RSVP, and your group would love to have you aboard.
      </p>

      {props.coordinator_message && (
        <blockquote
          style={{
            margin: "0 0 24px",
            padding: "16px 20px",
            background: "#f9fafb",
            borderLeft: `4px solid ${accent}`,
            fontFamily: "Georgia, serif",
            fontSize: 15,
            lineHeight: 1.7,
            color: "#1f2937",
          }}
        >
          {props.coordinator_message}
        </blockquote>
      )}

      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ marginBottom: 24, fontSize: 14 }}>
        <tbody>
          <TripRow label="Cruise line" value={props.cruise_line} />
          <TripRow label="Ship" value={props.ship_name} />
          <TripRow label="Sailing date" value={sailingDate} />
        </tbody>
      </table>

      {props.invite_url && (
        <CtaButton href={props.invite_url} accent={accent}>
          View trip &amp; RSVP
        </CtaButton>
      )}

      <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.7 }}>
        Questions? Reply to your group coordinator.
      </p>

      <p style={{ textAlign: "center", fontSize: 15, fontWeight: 600, color: primary, marginTop: 24 }}>
        Cabins fill up — don&rsquo;t miss the boat!
      </p>
    </BrandedLayout>
  );
}

function TripRow(props: { label: string; value: string }): React.ReactElement {
  return (
    <tr>
      <td style={{ padding: "4px 0", color: "#6b7280", width: 140 }}>{props.label}</td>
      <td style={{ padding: "4px 0", fontWeight: 500, color: "#111827" }}>{props.value}</td>
    </tr>
  );
}
