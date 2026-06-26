// §7.6 — CRM bookings list page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks bookings:read are
// redirected to "/" before the client shell is sent to the browser.
// bookings:read is in READ_GRANTS, matching the GET /api/bookings gate.

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { BookingsView } from "./_components/BookingsView";

export default async function BookingsListPage() {
  await assertPermissionPage({ resource: "bookings", action: "read" });
  return <BookingsView />;
}
