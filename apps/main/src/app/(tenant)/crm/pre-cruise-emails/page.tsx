// §23.4 — Staff workspace for manually sending or scheduling pre-cruise emails.

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { PreCruiseEmailsView } from "./_components/PreCruiseEmailsView";

export default async function PreCruiseEmailsPage() {
  await assertPermissionPage({ resource: "precruise_emails", action: "send" });
  return <PreCruiseEmailsView />;
}
