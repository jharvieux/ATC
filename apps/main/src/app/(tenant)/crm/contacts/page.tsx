// §12 — CRM contacts list page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks contacts:list are
// redirected to "/" before the client shell is sent to the browser.
// contacts:list is in READ_GRANTS, so all authenticated tenant members
// can reach this page.

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { ContactsView } from "./_components/ContactsView";

export default async function CrmContactsPage() {
  await assertPermissionPage({ resource: "contacts", action: "list" });
  return <ContactsView />;
}
