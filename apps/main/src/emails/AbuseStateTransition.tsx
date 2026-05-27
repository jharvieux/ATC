// §27.8 — Tenant-admin notification email for an abuse state transition.
//
// Copy slotted from platform_settings.abuse_notification_copy (operator-
// editable). This component is presentational; lookup is the caller's job.
 

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface AbuseStateTransitionProps {
  layout: Omit<BrandedLayoutProps, "children">;
  recipient_name: string;
  dimension: "ai_cost" | "chat_volume" | "email_volume" | "group_invite" | "rag_cap";
  from_state: string;
  to_state: string;
  subject_template: string;
  body_intro: string;
  /** ISO timestamp the transition was detected at. */
  detected_at: string;
  /** Where the admin can request an override / inspect usage. */
  usage_page_url: string;
  /** Optional metric snapshot for context. */
  metric_value?: string | null;
  threshold_crossed?: string | null;
}

const DIM_LABEL: Record<AbuseStateTransitionProps["dimension"], string> = {
  ai_cost:      "AI usage cost",
  chat_volume:  "Chat volume",
  email_volume: "Email volume",
  group_invite: "Group invitations",
  rag_cap:      "RAG knowledge base capacity",
};

export function AbuseStateTransition(
  props: AbuseStateTransitionProps,
): React.ReactElement {
  return (
    <BrandedLayout {...props.layout}>
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>{props.subject_template}</h2>
      <p>Hello {props.recipient_name},</p>
      <p style={{ lineHeight: 1.6 }}>{props.body_intro}</p>

      <h3 style={{ color: "#374151" }}>Status</h3>
      <ul style={{ lineHeight: 1.6 }}>
        <li><strong>Dimension:</strong> {DIM_LABEL[props.dimension]}</li>
        <li><strong>State change:</strong> {props.from_state} → {props.to_state}</li>
        <li><strong>Detected:</strong> {new Date(props.detected_at).toLocaleString()}</li>
        {props.metric_value && props.threshold_crossed && (
          <li><strong>Current vs threshold:</strong> {props.metric_value} / {props.threshold_crossed}</li>
        )}
      </ul>

      <h3 style={{ color: "#374151" }}>What to do</h3>
      <p style={{ lineHeight: 1.6 }}>
        Review your usage and (if needed) request an override on the{" "}
        <a href={props.usage_page_url} style={{ color: "#3b82f6" }}>
          usage settings page
        </a>.
        Approved overrides take effect immediately and last 30 days by default.
      </p>
    </BrandedLayout>
  );
}
