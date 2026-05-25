// BP37 §37.3.2 — Task reminder email.
//
// Sent by the task-reminders-fire cron when a task_reminders row with
// channel='email' fires. Wrapped in BrandedLayout for visual consistency.

import * as React from "react";
import { BrandedLayout } from "./BrandedLayout";

export interface TaskReminderProps {
  branding: {
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    accent_color?: string | null;
    slogan?: string | null;
  };
  tenant_legal_name: string;
  tenant_business_address: string;
  recipient_name: string;
  task_title: string;
  task_description: string | null;
  due_at: string | null;
  priority: string;
  task_url: string;
  unsubscribe_url: string;
}

export function TaskReminder(props: TaskReminderProps): React.ReactElement {
  const dueLabel = props.due_at ? new Date(props.due_at).toLocaleString() : "no due date";
  const priorityLabel = props.priority.charAt(0).toUpperCase() + props.priority.slice(1);

  return (
    <BrandedLayout
      branding={props.branding}
      tenant_legal_name={props.tenant_legal_name}
      tenant_business_address={props.tenant_business_address}
      unsubscribe_url={props.unsubscribe_url}
    >
      <p style={{ fontSize: 16, lineHeight: 1.5, color: "#111" }}>
        Hi {props.recipient_name},
      </p>
      <p style={{ fontSize: 16, lineHeight: 1.5, color: "#111" }}>
        This is a reminder for the following task:
      </p>
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 6,
          padding: 16,
          margin: "16px 0",
          background: "#fafafa",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600, color: "#111", marginBottom: 6 }}>
          {props.task_title}
        </div>
        {props.task_description && (
          <div style={{ fontSize: 14, color: "#444", marginBottom: 10, whiteSpace: "pre-wrap" }}>
            {props.task_description}
          </div>
        )}
        <div style={{ fontSize: 13, color: "#666" }}>
          Due: <strong>{dueLabel}</strong> · Priority: <strong>{priorityLabel}</strong>
        </div>
      </div>
      <p style={{ fontSize: 14, color: "#444" }}>
        <a
          href={props.task_url}
          style={{
            display: "inline-block",
            padding: "10px 16px",
            background: props.branding.primary_color ?? "#1f4e79",
            color: "#fff",
            textDecoration: "none",
            borderRadius: 4,
            fontWeight: 600,
          }}
        >
          Open in CRM
        </a>
      </p>
    </BrandedLayout>
  );
}
