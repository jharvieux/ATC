// BP34 §34.2.4 — mount the persistent Gmail health banner above the CRM
// pages. Without it, agents can send IMPORT emails for weeks expecting
// parsing while a revoked/expired token silently drops them.
//
// Tier-gated: the BYO Research tier has no Gmail integration at all, so the
// banner never mounts for it (per the component's own contract). If the
// tier can't be resolved we withhold the banner rather than show a Gmail
// warning to a tenant that may not have the feature.

import type React from "react";
import { GmailHealthBanner } from "@/components/integrations/GmailHealthBanner";
import { getRequestTenantTierCode } from "@/lib/tenancy/request-tenant-tier";

const GMAIL_BLOCKED_TIERS: ReadonlySet<string> = new Set(["byo_research"]);

export default async function CrmLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const tier = await getRequestTenantTierCode();
  const showBanner = tier != null && !GMAIL_BLOCKED_TIERS.has(tier);
  return (
    <>
      {showBanner && <GmailHealthBanner />}
      {children}
    </>
  );
}
