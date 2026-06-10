// §23.4 — T-30 day pre-cruise email template (Final prep window).
// #975 — marketing-grade layout: countdown badge, eyebrow section headings,
// checklist cards, and a tenant-accent CTA.

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { DestinationHero } from "./DestinationHero";
import { SectionHeading, CtaButton, CountdownBadge, ChecklistCard, DEFAULT_PRIMARY, DEFAULT_ACCENT } from "./EmailParts";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";

export interface PreCruiseT30Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  sailing_date: string;
  destination_image?: DestinationImage | null;
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
  const primary = props.layout.branding.primary_color ?? DEFAULT_PRIMARY;
  const accent = props.layout.branding.accent_color ?? DEFAULT_ACCENT;

  return (
    <BrandedLayout {...props.layout}>
      <CountdownBadge accent={accent}>30 days to go</CountdownBadge>

      <h2 style={{ color: primary, margin: "0 0 16px 0", fontSize: 24, textAlign: "center" }}>
        30 days until the {props.ship_name} sets sail!
      </h2>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <p style={{ lineHeight: 1.7 }}>
        Hi {props.customer_name}, it&rsquo;s crunch time — let&rsquo;s make sure everything is in
        order so the only thing left to do is count the days.
      </p>

      {props.reservation_reminders.length > 0 && (
        <>
          <SectionHeading accent={accent}>Reservations to Confirm</SectionHeading>
          <ChecklistCard accent={accent} items={props.reservation_reminders} />
        </>
      )}

      <SectionHeading accent={accent}>Online Check-In Window</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.checkin_window}</p>

      {props.final_payment_note && (
        <>
          <SectionHeading accent={accent}>Final Payment</SectionHeading>
          <p style={{ lineHeight: 1.7 }}>{props.final_payment_note}</p>
        </>
      )}

      {props.personalized_recommendations.length > 0 && (
        <>
          <SectionHeading accent={accent}>Recommended Just for You</SectionHeading>
          <ChecklistCard accent={accent} items={props.personalized_recommendations} />
        </>
      )}

      <SectionHeading accent={accent}>Pack Inspiration</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.pack_inspiration}</p>

      {props.companion_page_url && (
        <CtaButton href={props.companion_page_url} accent={accent}>
          View Your Full Itinerary →
        </CtaButton>
      )}

      {props.destination_image && (
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0 0", textAlign: "center" }}>
          Cover image: {props.destination_image.attribution}
        </p>
      )}
    </BrandedLayout>
  );
}
