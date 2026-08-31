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
  cruise_forecast?: DailyForecast[] | null;
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

      <p style={{ margin: "0 0 8px 0", color: accent, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textAlign: "center", textTransform: "uppercase" }}>
        Your final week
      </p>
      <h1 style={{ color: primary, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 30, fontWeight: 700, lineHeight: 1.15, margin: "0 0 20px 0", textAlign: "center" }}>
        Almost time to step aboard.
      </h1>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "0 0 6px 0", borderLeft: `4px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 0 4px 16px", color: "#425466", fontSize: 15, lineHeight: 1.7 }}>
              Hi {props.customer_name}, your voyage on <strong style={{ color: primary }}>{props.ship_name}</strong> departs <strong style={{ color: primary }}>{props.sailing_date}</strong>. This is your calm, practical run-through for the week ahead.
            </td>
          </tr>
        </tbody>
      </table>

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

      <SectionHeading accent={accent}>Embarkation day, made easy</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 4 }}>
        <tbody>
          <tr>
            <td width={6} style={{ backgroundColor: accent, fontSize: 1, lineHeight: "1px" }}>&nbsp;</td>
            <td style={{ padding: "16px 18px", color: "#425466", fontSize: 14, lineHeight: 1.6 }}>{props.embarkation_advice}</td>
          </tr>
        </tbody>
      </table>

      <SectionHeading accent={accent}>Your first day aboard</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f8f6f1", borderTop: `3px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "18px 20px", color: "#425466", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 16, lineHeight: 1.65 }}>{props.first_day_inspiration}</td>
          </tr>
        </tbody>
      </table>

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
