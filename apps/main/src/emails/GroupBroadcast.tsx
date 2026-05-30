// §18.6 — Coordinator broadcast email body, rendered through BrandedLayout
// for both the actual send and the in-app preview on the coordinate page.

import * as React from "react";
import { BrandedLayout, type BrandedLayoutProps } from "./BrandedLayout";

export interface GroupBroadcastProps {
  branding: BrandedLayoutProps["branding"];
  tenant_legal_name: string;
  tenant_business_address: string;
  unsubscribe_url: string;
  subject: string;
  message: string;
  group_name: string;
}

export function GroupBroadcast(props: GroupBroadcastProps): React.ReactElement {
  const paragraphs = props.message.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return (
    <BrandedLayout
      branding={props.branding}
      tenant_legal_name={props.tenant_legal_name}
      tenant_business_address={props.tenant_business_address}
      unsubscribe_url={props.unsubscribe_url}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
        {props.subject}
      </h1>
      <p style={{ color: "#6b7280", marginBottom: 20 }}>
        From your coordinator — {props.group_name}
      </p>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ marginBottom: 12, lineHeight: 1.5 }}>
          {p}
        </p>
      ))}
    </BrandedLayout>
  );
}
