// Concierge message email — sent when a customer asks the AI to email them
// something (deck-plan links, itinerary, quote summary). The body is the AI's
// drafted message; it is rendered as escaped text (React text nodes) with
// http(s) URLs auto-linked. No markdown HTML is interpreted, so model output
// cannot inject markup into the email.

import * as React from "react";
import { BrandedLayout } from "./BrandedLayout";

// Split a line on http(s) URLs and render the URL segments as links. Non-http
// segments (and the whole thing) are React text nodes, so they're escaped.
function linkifyLine(line: string): React.ReactNode[] {
  return line.split(/(https?:\/\/[^\s<]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} style={{ color: "#2563eb" }}>
        {part}
      </a>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

// Render plain text into paragraphs (blank-line separated) with <br> for single
// newlines. All text is escaped by React; URLs are auto-linked.
function renderBody(text: string): React.ReactNode {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para, pi) => {
      const lines = para.split("\n");
      return (
        <p key={pi} style={{ margin: "0 0 16px 0", fontSize: 15, lineHeight: 1.5, color: "#222" }}>
          {lines.map((line, li) => (
            <React.Fragment key={li}>
              {linkifyLine(line)}
              {li < lines.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </p>
      );
    });
}

export interface ConciergeMessageProps {
  branding: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    slogan?: string | null;
  };
  tenant_legal_name: string;
  tenant_business_address: string;
  persona_name: string;
  body: string;
  unsubscribe_url: string;
}

export function ConciergeMessage(props: ConciergeMessageProps): React.ReactElement {
  return (
    <BrandedLayout
      branding={props.branding}
      tenant_legal_name={props.tenant_legal_name}
      tenant_business_address={props.tenant_business_address}
      unsubscribe_url={props.unsubscribe_url}
    >
      {renderBody(props.body)}
      <p style={{ margin: "24px 0 0 0", fontSize: 14, color: "#666" }}>
        — {props.persona_name}, AI Travel Concierge
      </p>
    </BrandedLayout>
  );
}
