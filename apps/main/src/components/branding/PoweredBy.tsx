// §16.7 — Configurable Powered-by attribution badge for the customer-facing UI footer.
// Visibility controlled by tenant_branding.show_powered_by (server-coerced to TRUE for
// BYO Research / BYO Professional / Sub-Host Starter tiers by the branding API).

import * as React from "react";

export interface PoweredByProps {
  show: boolean;
}

export function PoweredBy({ show }: PoweredByProps): React.ReactElement | null {
  if (!show) return null;
  return (
    <div className="text-xs text-gray-400 py-2 text-center">
      Powered by{" "}
      <a
        href="https://ai-travelconcierge.com"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline"
      >
        AI Travel Concierge
      </a>
    </div>
  );
}
