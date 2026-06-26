// §12.4 / §38 — CRM quotes list page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks quotes:read are
// redirected to "/" before the client shell is sent to the browser.
// quotes:read is in AGENT_GRANTS (staff-only), matching the GET /api/quotes gate.

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { QuotesView } from "./_components/QuotesView";

export default async function CrmQuotesPage() {
  await assertPermissionPage({ resource: "quotes", action: "read" });
  return <QuotesView />;
}
