// #902 PR B — standalone TA-mode chat route. The experience itself lives in
// components/concierge/ConciergeExperience so the tenant landing shell can
// embed it as the staff default panel (#974); this route keeps the deep link
// working under the SiteHeader chrome, hence the explicit height container.

import { ConciergeExperience } from "@/components/concierge/ConciergeExperience";

export default function ConciergePage(): React.JSX.Element {
  return (
    <div className="h-[calc(100vh-4rem)]">
      <ConciergeExperience />
    </div>
  );
}
