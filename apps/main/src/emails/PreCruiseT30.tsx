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

      <p style={{ margin: "0 0 8px 0", color: accent, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textAlign: "center", textTransform: "uppercase" }}>
        Your departure edit
      </p>
      <h2 style={{ color: primary, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 30, fontWeight: 700, lineHeight: 1.15, margin: "0 0 20px 0", textAlign: "center" }}>
        Thirty days to sail-away.
      </h2>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "0 0 6px 0", borderLeft: `4px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 0 4px 16px", color: "#425466", fontSize: 15, lineHeight: 1.7 }}>
              Hi {props.customer_name}, your place aboard <strong style={{ color: primary }}>{props.ship_name}</strong> for <strong style={{ color: primary }}>{props.sailing_date}</strong> is getting wonderfully close. Let&rsquo;s settle the details so the final month feels effortless.
            </td>
          </tr>
        </tbody>
      </table>

      {props.reservation_reminders.length > 0 && (
        <>
          <SectionHeading accent={accent}>Reservations to Confirm</SectionHeading>
          <ChecklistCard accent={accent} items={props.reservation_reminders} />
        </>
      )}

      <SectionHeading accent={accent}>Put this on your calendar</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 4 }}>
        <tbody>
          <tr>
            <td width={6} style={{ backgroundColor: accent, fontSize: 1, lineHeight: "1px" }}>&nbsp;</td>
            <td style={{ padding: "16px 18px", color: "#425466", fontSize: 14, lineHeight: 1.6 }}>
              <strong style={{ color: primary }}>Online check-in</strong><br />
              {props.checkin_window}
            </td>
          </tr>
        </tbody>
      </table>

      {props.final_payment_note && (
        <>
          <SectionHeading accent={accent}>Final payment</SectionHeading>
          <p style={{ margin: 0, color: "#425466", lineHeight: 1.7 }}>{props.final_payment_note}</p>
        </>
      )}

      {props.personalized_recommendations.length > 0 && (
        <>
          <SectionHeading accent={accent}>Recommended Just for You</SectionHeading>
          <ChecklistCard accent={accent} items={props.personalized_recommendations} />
        </>
      )}

      {props.specialty_experiences && props.specialty_experiences.length > 0 && (
        <>
          <SectionHeading accent={accent}>Worth reserving</SectionHeading>
          <ChecklistCard accent={accent} items={props.specialty_experiences} />
        </>
      )}

      <SectionHeading accent={accent}>Picture yourself there</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f8f6f1", borderTop: `3px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "18px 20px", color: "#425466", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 16, lineHeight: 1.65 }}>{props.pack_inspiration}</td>
          </tr>
        </tbody>
      </table>

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
