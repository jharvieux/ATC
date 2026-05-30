// §23.4 — T-90 day pre-cruise email template (Anticipation begins).

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";
import { DestinationHero } from "./DestinationHero";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";

export interface PreCruiseT90Props {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  ship_name: string;
  cruise_line: string;
  sailing_date: string;
  ports: string[];
  destination_image?: DestinationImage | null;
  // AI-generated content sections (cached per §23.4)
  documentation_reminder: string;
  destination_teaser: string;
  must_do_experiences: string[];
  did_you_know: string;
  suggested_reads?: string[];
}

export function PreCruiseT90(props: PreCruiseT90Props): React.ReactElement {
  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>
        Your {props.cruise_line} cruise is 90 days away! 🌊
      </h2>

      {props.destination_image && <DestinationHero image={props.destination_image} />}

      <p>
        Hi {props.customer_name}, we&rsquo;re so excited for your upcoming voyage on the{" "}
        <strong>{props.ship_name}</strong>, departing <strong>{props.sailing_date}</strong>.
      </p>

      <h3 style={{ color: "#374151" }}>Documentation Reminder</h3>
      <p style={{ lineHeight: 1.7 }}>{props.documentation_reminder}</p>

      <h3 style={{ color: "#374151" }}>Your Ports of Call</h3>
      <ul>
        {props.ports.map((port) => (
          <li key={port}>{port}</li>
        ))}
      </ul>

      <h3 style={{ color: "#374151" }}>What Awaits You</h3>
      <p style={{ lineHeight: 1.7 }}>{props.destination_teaser}</p>

      {props.must_do_experiences.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>Must-Do Experiences</h3>
          <ul>
            {props.must_do_experiences.map((exp, i) => (
              <li key={i} style={{ marginBottom: 6 }}>{exp}</li>
            ))}
          </ul>
        </>
      )}

      <h3 style={{ color: "#374151" }}>Did You Know?</h3>
      <p style={{ fontStyle: "italic", lineHeight: 1.7, color: "#4b5563" }}>
        {props.did_you_know}
      </p>

      {props.suggested_reads && props.suggested_reads.length > 0 && (
        <>
          <h3 style={{ color: "#374151" }}>Suggested Reading &amp; Viewing</h3>
          <ul>
            {props.suggested_reads.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {props.destination_image && (
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0 0", textAlign: "center" }}>
          Cover image: {props.destination_image.attribution}
        </p>
      )}

      <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "24px 0" }} />
      <p style={{ fontSize: 13, color: "#6b7280" }}>
        Questions? Your travel concierge is just a message away. Reply to this email or use the
        chat on your booking portal.
      </p>
    </BrandedLayout>
  );
}
