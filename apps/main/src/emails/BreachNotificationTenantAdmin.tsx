// §25.9 — Tenant-admin-facing breach notification email.
// Different shape from BreachNotificationUser: tenant admins need
// operationally actionable info (who's on point, when their SLA is,
// where to read the post-mortem-in-progress).
 

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface BreachNotificationTenantAdminProps {
  layout: Omit<BrandedLayoutProps, "children">;
  recipient_name: string;
  breach_summary: {
    severity: "low" | "medium" | "high" | "critical";
    discovered_at: string;
    affected_user_count: number;
    data_categories_affected: string[];
    confirmed_or_suspected: "confirmed" | "suspected";
    platform_oncall_contact_email: string;
    runbook_url: string;
    notification_due_to_users_at?: string | null; // ISO; 72h-from-discovery for user notice
  };
}

export function BreachNotificationTenantAdmin(
  props: BreachNotificationTenantAdminProps,
): React.ReactElement {
  const sum = props.breach_summary;
  return (
    <BrandedLayout {...props.layout}>
      {/* TODO(legal-counsel): final wording is attorney-reviewed. */}
      <h2 style={{ color: "#1f2937", marginTop: 0 }}>
        Security incident notification — action required
      </h2>
      <p>Hello {props.recipient_name},</p>
      <p>
        The platform has detected a <strong>{sum.severity}</strong> severity
        security incident affecting accounts in your tenant. Per §25.9 you
        are receiving this notice within 24 hours of discovery.
      </p>

      <h3 style={{ color: "#374151" }}>What we know</h3>
      <ul>
        <li>Status: <strong>{sum.confirmed_or_suspected}</strong></li>
        <li>Discovered: {new Date(sum.discovered_at).toLocaleString()}</li>
        <li>Affected accounts in your tenant: {sum.affected_user_count}</li>
        <li>Data categories: {sum.data_categories_affected.join(", ") || "investigating"}</li>
        {sum.notification_due_to_users_at && (
          <li>
            Users will be notified by{" "}
            {new Date(sum.notification_due_to_users_at).toLocaleString()} (72h SLA).
          </li>
        )}
      </ul>

      <h3 style={{ color: "#374151" }}>Who&rsquo;s on point</h3>
      <p style={{ lineHeight: 1.6 }}>
        Platform oncall:{" "}
        <a href={`mailto:${sum.platform_oncall_contact_email}`} style={{ color: "#3b82f6" }}>
          {sum.platform_oncall_contact_email}
        </a>
      </p>

      <h3 style={{ color: "#374151" }}>What to do now</h3>
      <ul style={{ lineHeight: 1.6 }}>
        <li>
          Read the live runbook:{" "}
          <a href={sum.runbook_url} style={{ color: "#3b82f6" }}>
            {sum.runbook_url}
          </a>
        </li>
        <li>Identify any of your customers in the affected accounts list (shared securely under separate cover).</li>
        <li>Prepare any tenant-side communications you want to layer on top of the platform&rsquo;s user notification.</li>
      </ul>
    </BrandedLayout>
  );
}
