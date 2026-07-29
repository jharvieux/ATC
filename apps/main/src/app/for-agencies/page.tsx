// The agency landing page moved to "/" — it is the product's primary
// audience, and the root domain is the strongest URL to rank it on.
//
// This route stays as a permanent redirect rather than a 404: it is the URL
// that was live, so external links, any indexed copy, and the old header
// menu entry all still resolve. permanentRedirect() emits 308, which search
// engines treat as a 301 and use to transfer ranking signals to "/".
//
// On a tenant subdomain this lands the visitor on that tenant's own hero,
// which is also the right outcome — the agency landing never renders there.

import { permanentRedirect } from "next/navigation";

export default function ForAgenciesPage(): never {
  permanentRedirect("/");
}
