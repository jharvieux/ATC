// §25.9 — Customer-facing breach notification email.
// Renders BrandedLayout with the legally-required disclosures slotted in.
// Wording is TODO(legal-counsel) until counsel signs off.
 

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface BreachNotificationUserProps {
  layout: Omit<BrandedLayoutProps, "children">;
  customer_name: string;
  // Structured summary of the breach. Operator passes this from the helper.
  breach_summary: {
    discovered_at: string;          // ISO date
    data_categories_affected: string[]; // e.g. ['email_address', 'phone']
    confirmed_or_suspected: "confirmed" | "suspected";
    remediation_summary: string;    // 1-2 sentences plain language
    customer_action_needed?: string | null;
  };
  // Platform-generated, counsel-approved legal HTML (CA AG link, etc.) — rendered
  // as raw HTML below, so it MUST NOT carry tenant- or user-supplied input.
  // Currently unset by the only caller (send-breach-notifications.ts).
  state_law_disclosures_html?: string;
}

export function BreachNotificationUser(props: BreachNotificationUserProps): React.ReactElement {
  const sum = props.breach_summary;
  return (
    <BrandedLayout {...props.layout}>
      {/* TODO(legal-counsel): final wording is attorney-reviewed. */}
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>Important security notice</h2>
      <p>Dear {props.customer_name},</p>
      <p>
        We&rsquo;re writing to let you know about a {sum.confirmed_or_suspected}{" "}
        security incident that may have affected your account. We discovered
        the incident on{" "}
        <strong>{new Date(sum.discovered_at).toLocaleDateString()}</strong> and
        are sharing what we know now in line with the law&rsquo;s notification
        requirements.
      </p>

      <h3 style={{ color: "#374151" }}>What may have been involved</h3>
      <ul>
        {sum.data_categories_affected.map((cat) => (
          <li key={cat}>{cat.replace(/_/g, " ")}</li>
        ))}
      </ul>

      <h3 style={{ color: "#374151" }}>What we&rsquo;re doing</h3>
      <p style={{ lineHeight: 1.6 }}>{sum.remediation_summary}</p>

      {sum.customer_action_needed && (
        <>
          <h3 style={{ color: "#374151" }}>What you can do</h3>
          <p style={{ lineHeight: 1.6 }}>{sum.customer_action_needed}</p>
        </>
      )}

      {props.state_law_disclosures_html && (
        <>
          <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "24px 0" }} />
          {/* Raw HTML by contract: platform/counsel-approved legal text only, never user input (see prop docs). */}
          <div
            style={{ fontSize: 12, color: "#555", lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: props.state_law_disclosures_html }}
          />
        </>
      )}
    </BrandedLayout>
  );
}
