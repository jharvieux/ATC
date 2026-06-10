// §23.4 — T-90 day pre-cruise email template (Anticipation begins).
// #975 — marketing-grade layout: countdown badge, eyebrow section headings,
// checklist cards, and a companion-page CTA, all tenant-accent aware.

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

      <h2 style={{ color: primary, margin: "0 0 16px 0", fontSize: 24, textAlign: "center" }}>
        Your {props.cruise_line} cruise is 90 days away! 🌊
      </h2>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <p style={{ lineHeight: 1.7 }}>
        Hi {props.customer_name}, we&rsquo;re so excited for your upcoming voyage on the{" "}
        <strong>{props.ship_name}</strong>, departing <strong>{props.sailing_date}</strong>.
        Here&rsquo;s what to start thinking about — and dreaming about.
      </p>

      <SectionHeading accent={accent}>Documentation Reminder</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.documentation_reminder}</p>

      {props.ports.length > 0 && (
        <>
          <SectionHeading accent={accent}>Your Ports of Call</SectionHeading>
          <ChecklistCard accent={accent} items={props.ports} />
        </>
      )}

      <SectionHeading accent={accent}>What Awaits You</SectionHeading>
      <p style={{ lineHeight: 1.7 }}>{props.destination_teaser}</p>

      {props.must_do_experiences.length > 0 && (
        <>
          <SectionHeading accent={accent}>Must-Do Experiences</SectionHeading>
          <ChecklistCard accent={accent} items={props.must_do_experiences} />
        </>
      )}

      <SectionHeading accent={accent}>Did You Know?</SectionHeading>
      <p style={{ fontStyle: "italic", lineHeight: 1.7, color: "#4b5563" }}>
        {props.did_you_know}
      </p>

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

      <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "24px 0" }} />
      <p style={{ fontSize: 13, color: "#6b7280", textAlign: "center" }}>
        Questions? Your travel concierge is just a message away. Reply to this email or use the
        chat on your booking portal.
      </p>
    </BrandedLayout>
  );
}
