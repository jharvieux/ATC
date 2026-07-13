// §16.7.1 — Every /legal/* page renders the always-on tenant attribution
// banner at the top, regardless of tier or tenant configuration. Mounting
// it in the shared legal layout guarantees no legal route can ship without
// it. On the platform domain (no resolved tenant) we name the platform's
// own legal entity as the responsible party.

import type React from "react";
import { LegalPageAttribution } from "@/components/branding/LegalPageAttribution";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";

export default async function LegalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.ReactElement> {
  const branding = await getRequestTenantBranding();
  return (
    <>
      <LegalPageAttribution tenant_display_name={branding?.display_name ?? "AI Travel Concierge"} />
      {children}
    </>
  );
}
