// BP34 §34.6 — CRM imports pending review page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks imports.review:list are
// redirected to "/" before the client shell is sent to the browser.
// imports.review:list is in AGENT_GRANTS (staff-only).

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { ImportsView } from "./_components/ImportsView";

export default async function ImportsReviewPage() {
  await assertPermissionPage({ resource: "imports.review", action: "list" });
  return <ImportsView />;
}
