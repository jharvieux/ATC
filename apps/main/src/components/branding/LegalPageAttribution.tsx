// §16.7.1 — Always-on attribution at the top of every /legal/* page.
// NOT customizable by tenant — renders regardless of tier or show_powered_by.
// TODO(legal-attorney) (#1846): final wording per §16.7.1. Current text is illustrative.

import * as React from "react";

export interface LegalPageAttributionProps {
  tenant_display_name: string;
}

export function LegalPageAttribution({ tenant_display_name }: LegalPageAttributionProps): React.ReactElement {
  return (
    <div className="text-xs text-gray-500 bg-gray-50 border-b border-gray-200 px-4 py-3 mb-6">
      {/* TODO(legal-attorney) (#1846): wording is illustrative per §16.7.1; §16.7.2
          OPERATOR CONFIRM requires attorney sign-off on final language. */}
      This site is operated by {tenant_display_name} (the &ldquo;Travel Agency&rdquo;)
      using the AI Travel Concierge platform (the &ldquo;Platform&rdquo;). The Travel
      Agency is the seller of travel and is solely responsible for trip bookings and
      related services. For questions about the underlying platform technology, see the
      Platform&rsquo;s terms of use.
    </div>
  );
}
