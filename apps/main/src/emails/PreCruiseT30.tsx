// §23.4 — T-30 day pre-cruise email template (Final prep window).
/* eslint-disable @next/next/no-head-element, @next/next/no-img-element */

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface PreCruiseT30Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  sailing_date: string;
  // AI-generated sections
  reservation_reminders: string[];
  checkin_window: string;
  final_payment_note?: string | null;
  personalized_recommendations: string[];
  specialty_experiences?: string[];
  pack_inspiration: string;
  companion_page_url?: string;
}

export function PreCruiseT30(props: PreCruiseT30Props): React.ReactElement {
  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>
        30 days until the {props.ship_name} sets sail!
      </h2>
      <p>Hi {props.customer_name}, it&rsquo;s crunch time — let&rsquo;s make sure everything is in order.</p>

      {props.reservation_reminders.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>Reservations to Confirm</h3>
          <ul>
            {props.reservation_reminders.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </>
      )}

      <h3 style={{ color: "#374151" }}>Online Check-In Window</h3>
      <p style={{ lineHeight: 1.7 }}>{props.checkin_window}</p>

      {props.final_payment_note && (
        <>
          <h3 style={{ color: "#374151" }}>Final Payment</h3>
          <p style={{ lineHeight: 1.7 }}>{props.final_payment_note}</p>
        </>
      )}

      {props.personalized_recommendations.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>Recommended Just for You</h3>
          <ul>
            {props.personalized_recommendations.map((r, i) => <li key={i} style={{ marginBottom: 6 }}>{r}</li>)}
          </ul>
        </>
      )}

      <h3 style={{ color: "#374151" }}>Pack Inspiration</h3>
      <p style={{ lineHeight: 1.7 }}>{props.pack_inspiration}</p>

      {props.companion_page_url && (
        <p style={{ marginTop: 24 }}>
          <a
            href={props.companion_page_url}
            style={{ background: "#3b82f6", color: "#fff", padding: "12px 24px", borderRadius: 6, textDecoration: "none" }}
          >
            View Your Full Itinerary →
          </a>
        </p>
      )}
    </BrandedLayout>
  );
}
