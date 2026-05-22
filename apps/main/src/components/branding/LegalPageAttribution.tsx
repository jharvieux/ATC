// §16.7.1 — Always-on attribution at the top of every /legal/* page.
// NOT customizable by tenant — renders regardless of tier or show_powered_by.
// TODO(legal-attorney): final wording per §16.7.1. Current text is illustrative.

import * as React from "react";

export interface LegalPageAttributionProps {
  tenant_display_name: string;
}

export function LegalPageAttribution({ tenant_display_name }: LegalPageAttributionProps): React.ReactElement {
  return (
    <div className="text-xs text-gray-500 bg-gray-50 border-b border-gray-200 px-4 py-3 mb-6">
      {/* TODO(legal-attorney): final wording per §16.7.1 */}
      {tenant_display_name} operates this booking experience using the AI Travel
      Concierge platform. The terms below govern your use of the {tenant_display_name}{" "}
      experience; platform terms of use apply concurrently.
    </div>
  );
}
