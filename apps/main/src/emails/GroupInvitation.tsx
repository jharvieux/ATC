// §18.4 — Group invitation email template.
// Extends BrandedLayout with destination hero image, coordinator letter-style
// message, cruise details, cabin grid summary, CTA button, and CAN-SPAM footer.
/* eslint-disable @next/next/no-img-element */

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface GroupInvitationProps {
  branding: BrandedLayoutProps["branding"];
  tenant_legal_name: string;
  tenant_business_address: string;
  unsubscribe_url: string;
  // Invitee
  invitee_name: string | null;
  // Group details
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  coordinator_message: string | null;
  hero_image_url: string | null;
  // Cabin grid summary (counts only — names hidden per §18.6)
  booked_count: number;
  interested_count: number;
  // Token link
  invite_url: string;
  // Optional group rate
  target_group_rate_formatted?: string | null;
}

export function GroupInvitation(props: GroupInvitationProps): React.ReactElement {
  const greeting = props.invitee_name ? `Hi ${props.invitee_name}!` : "Hi there!";

  return (
    <BrandedLayout
      branding={props.branding}
      tenant_legal_name={props.tenant_legal_name}
      tenant_business_address={props.tenant_business_address}
      unsubscribe_url={props.unsubscribe_url}
    >
      {/* Hero image */}
      {props.hero_image_url && (
        <div style={{ margin: "-24px -32px 24px", overflow: "hidden" }}>
          <img
            src={props.hero_image_url}
            alt={`${props.departure_port} destination`}
            style={{ width: "100%", maxHeight: 240, objectFit: "cover", display: "block" }}
          />
        </div>
      )}

      {/* Greeting */}
      <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{greeting}</p>
      <p style={{ color: "#374151", marginBottom: 24 }}>
        You&apos;ve been invited to join a group cruise!
      </p>

      {/* Coordinator message — styled like a letter from a friend */}
      {props.coordinator_message && (
        <blockquote style={{
          margin: "0 0 24px",
          padding: "16px 20px",
          background: "#f9fafb",
          borderLeft: "4px solid #6366f1",
          fontFamily: "Georgia, serif",
          fontSize: 15,
          lineHeight: 1.7,
          color: "#1f2937",
        }}>
          {props.coordinator_message}
        </blockquote>
      )}

      {/* Trip details */}
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ marginBottom: 24, fontSize: 14 }}>
        <tbody>
          <TripRow label="Cruise line" value={props.cruise_line} />
          <TripRow label="Ship" value={props.ship_name} />
          <TripRow label="Sailing date" value={new Date(props.sailing_date).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} />
          <TripRow label="Departure port" value={props.departure_port} />
          {props.target_group_rate_formatted && (
            <TripRow label="Target group rate" value={props.target_group_rate_formatted} />
          )}
        </tbody>
      </table>

      {/* Cabin grid summary */}
      {(props.booked_count > 0 || props.interested_count > 0) && (
        <div style={{ background: "#ecfdf5", borderRadius: 8, padding: "12px 16px", marginBottom: 24, fontSize: 13, color: "#065f46" }}>
          <strong>{props.booked_count}</strong> cabin{props.booked_count !== 1 ? "s" : ""} booked
          {props.interested_count > 0 && `, <strong>${props.interested_count}</strong> interested`}
        </div>
      )}

      {/* CTA */}
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <a
          href={props.invite_url}
          style={{
            display: "inline-block",
            padding: "14px 32px",
            background: "#6366f1",
            color: "#fff",
            borderRadius: 8,
            textDecoration: "none",
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          View trip &amp; RSVP
        </a>
      </div>

      <p style={{ fontSize: 13, color: "#9ca3af" }}>
        This invitation is personal to you. Please don&apos;t share the link.
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
