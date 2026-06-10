// §23.4 — T-7 day pre-cruise email template (Almost there!).
// #975 — marketing-grade layout: countdown badge, eyebrow section headings,
// checklist cards, and a tenant-accent CTA.

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { CruiseForecastChart } from "./CruiseForecastChart";
import { DestinationHero } from "./DestinationHero";
import { SectionHeading, CtaButton, CountdownBadge, ChecklistCard, DEFAULT_PRIMARY, DEFAULT_ACCENT } from "./EmailParts";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";
import type { DailyForecast } from "@/lib/weather/cruise-forecast";

export interface PreCruiseT7Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  sailing_date: string;
  destination_image?: DestinationImage | null;
  // Multi-day forecast for the cruise. Open-Meteo's 16-day horizon means
  // T-7 captures the whole sailing for typical 7-night itineraries.
  cruise_forecast?: DailyForecast[] | null;
  // AI-generated sections
  packing_checklist: string[];
  ship_highlights: string[];
  cruise_line_tips: string[];
  embarkation_advice: string;
  first_day_inspiration: string;
  companion_page_url?: string;
}

export function PreCruiseT7(props: PreCruiseT7Props): React.ReactElement {
  const primary = props.layout.branding.primary_color ?? DEFAULT_PRIMARY;
  const accent = props.layout.branding.accent_color ?? DEFAULT_ACCENT;

  return (
    <BrandedLayout {...props.layout}>
      <CountdownBadge accent={accent}>One week to go</CountdownBadge>

      <h2 style={{ color: primary, margin: "0 0 16px 0", fontSize: 24, textAlign: "center" }}>
        Almost there, {props.customer_name}!
      </h2>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <p style={{ lineHeight: 1.7 }}>
        Your voyage on the <strong>{props.ship_name}</strong> departs{" "}
        <strong>{props.sailing_date}</strong>. Here&rsquo;s what to focus on this week.
      </p>

      {props.cruise_forecast && props.cruise_forecast.length > 0 && (
        <>
          <SectionHeading accent={accent}>Weather Along the Way</SectionHeading>
          <CruiseForecastChart forecast={props.cruise_forecast} />
        </>
      )}

      {props.packing_checklist.length > 0 && (
        <>
          <SectionHeading accent={accent}>Your Packing Checklist</SectionHeading>
          <ChecklistCard accent={accent} items={props.packing_checklist} />
        </>
      )}

      {props.ship_highlights.length > 0 && (
        <>
          <SectionHeading accent={accent}>Ship Highlights</SectionHeading>
          <ChecklistCard accent={accent} items={props.ship_highlights} />
        </>
      )}

      {props.cruise_line_tips.length > 0 && (
        <>
          <SectionHeading accent={accent}>Cruise Line Tips</SectionHeading>
          <ChecklistCard accent={accent} items={props.cruise_line_tips} />
        </>
      )}

      <SectionHeading accent={accent}>Embarkation Day</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.embarkation_advice}</p>

      <SectionHeading accent={accent}>Your First Day Aboard</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.first_day_inspiration}</p>

      {props.companion_page_url && (
        <CtaButton href={props.companion_page_url} accent={accent}>
          Full Voyage Guide →
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
