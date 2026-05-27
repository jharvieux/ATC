// §23.4 — T-7 day pre-cruise email template (Almost there!).
 

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface PreCruiseT7Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  sailing_date: string;
  // AI-generated sections
  packing_checklist: string[];
  ship_highlights: string[];
  cruise_line_tips: string[];
  embarkation_advice: string;
  first_day_inspiration: string;
  companion_page_url?: string;
}

export function PreCruiseT7(props: PreCruiseT7Props): React.ReactElement {
  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>
        One week to go — almost there, {props.customer_name}!
      </h2>
      <p>
        Your voyage on the <strong>{props.ship_name}</strong> departs{" "}
        <strong>{props.sailing_date}</strong>. Here&rsquo;s what to focus on this week.
      </p>

      {props.packing_checklist.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>AI-Generated Packing Checklist</h3>
          <ul>
            {props.packing_checklist.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        </>
      )}

      {props.ship_highlights.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>Ship Highlights</h3>
          <ul>
            {props.ship_highlights.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </>
      )}

      {props.cruise_line_tips.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>Cruise Line Tips</h3>
          <ul>
            {props.cruise_line_tips.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </>
      )}

      <h3 style={{ color: "#374151" }}>Embarkation Day</h3>
      <p style={{ lineHeight: 1.7 }}>{props.embarkation_advice}</p>

      <h3 style={{ color: "#374151" }}>Your First Day Aboard</h3>
      <p style={{ lineHeight: 1.7 }}>{props.first_day_inspiration}</p>

      {props.companion_page_url && (
        <p style={{ marginTop: 24 }}>
          <a
            href={props.companion_page_url}
            style={{ background: "#3b82f6", color: "#fff", padding: "12px 24px", borderRadius: 6, textDecoration: "none" }}
          >
            Full Voyage Guide →
          </a>
        </p>
      )}
    </BrandedLayout>
  );
}
