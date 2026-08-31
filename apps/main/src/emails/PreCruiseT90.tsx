import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { DestinationHero } from "./DestinationHero";
import { SectionHeading, CtaButton, CountdownBadge, ChecklistCard, DEFAULT_PRIMARY, DEFAULT_ACCENT } from "./EmailParts";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";

export interface PreCruiseT90Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  cruise_line: string;
  sailing_date: string;
  ports: string[];
  destination_image?: DestinationImage | null;
  companion_page_url?: string;
  // AI-generated content sections (cached per §23.4)
  documentation_reminder: string;
  destination_teaser: string;
  must_do_experiences: string[];
  did_you_know: string;
  suggested_reads?: string[];
}

export function PreCruiseT90(props: PreCruiseT90Props): React.ReactElement {
  const primary = props.layout.branding.primary_color ?? DEFAULT_PRIMARY;
  const accent = props.layout.branding.accent_color ?? DEFAULT_ACCENT;

  return (
    <BrandedLayout {...props.layout}>
      <CountdownBadge accent={accent}>90 days to go</CountdownBadge>

      <p style={{ margin: "0 0 8px 0", color: accent, fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textAlign: "center", textTransform: "uppercase" }}>
        Your voyage briefing
      </p>
      <h1 style={{ color: primary, fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 30, fontWeight: 700, lineHeight: 1.15, margin: "0 0 20px 0", textAlign: "center" }}>
        The horizon is getting closer.
      </h1>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ margin: "0 0 6px 0", borderLeft: `4px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "4px 0 4px 16px", color: "#425466", fontSize: 15, lineHeight: 1.7 }}>
              Hi {props.customer_name}, your <strong style={{ color: primary }}>{props.cruise_line}</strong> voyage on <strong style={{ color: primary }}>{props.ship_name}</strong> departs <strong style={{ color: primary }}>{props.sailing_date}</strong>. A little preparation now leaves more room for anticipation later.
            </td>
          </tr>
        </tbody>
      </table>

      <SectionHeading accent={accent}>Start with the essentials</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f7fafc", border: "1px solid #e2e8f0", borderRadius: 4 }}>
        <tbody>
          <tr>
            <td width={6} style={{ backgroundColor: accent, fontSize: 1, lineHeight: "1px" }}>&nbsp;</td>
            <td style={{ padding: "16px 18px", color: "#425466", fontSize: 14, lineHeight: 1.6 }}>{props.documentation_reminder}</td>
          </tr>
        </tbody>
      </table>

      {props.ports.length > 0 && (
        <>
          <SectionHeading accent={accent}>Your Ports of Call</SectionHeading>
          <ChecklistCard accent={accent} items={props.ports} />
        </>
      )}

      <SectionHeading accent={accent}>A glimpse of what awaits</SectionHeading>
      <p style={{ margin: 0, color: "#425466", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 17, lineHeight: 1.65 }}>{props.destination_teaser}</p>

      {props.must_do_experiences.length > 0 && (
        <>
          <SectionHeading accent={accent}>Must-Do Experiences</SectionHeading>
          <ChecklistCard accent={accent} items={props.must_do_experiences} />
        </>
      )}

      <SectionHeading accent={accent}>A little local knowledge</SectionHeading>
      <table role="presentation" width="100%" cellSpacing={0} cellPadding={0} style={{ backgroundColor: "#f8f6f1", borderTop: `3px solid ${accent}` }}>
        <tbody>
          <tr>
            <td style={{ padding: "18px 20px", color: "#425466", fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 16, fontStyle: "italic", lineHeight: 1.65 }}>
              “{props.did_you_know}”
            </td>
          </tr>
        </tbody>
      </table>

      {props.suggested_reads && props.suggested_reads.length > 0 && (
        <>
          <SectionHeading accent={accent}>Suggested Reading &amp; Viewing</SectionHeading>
          <ChecklistCard accent={accent} items={props.suggested_reads} />
        </>
      )}

      {props.companion_page_url && (
        <CtaButton href={props.companion_page_url} accent={accent}>
          Start Your Countdown →
        </CtaButton>
      )}

      {props.destination_image && (
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0 0", textAlign: "center" }}>
          Cover image: {props.destination_image.attribution}
        </p>
      )}

      <hr style={{ border: "none", borderTop: "1px solid #dce5ea", margin: "30px 0 18px 0" }} />
      <p style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6, margin: 0, textAlign: "center" }}>
        Questions? Your travel concierge is just a message away. Reply to this email or use the
        chat on your booking portal.
      </p>
    </BrandedLayout>
  );
}
