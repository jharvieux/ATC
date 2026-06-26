// §7.6 / #1173 — Bookings by source report page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks
// reports.bookings_by_source:read are redirected to "/" before the client
// shell is sent to the browser. reports.bookings_by_source:read is in
// AGENT_GRANTS (staff-only).

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { BookingsBySourceView } from "./_components/BookingsBySourceView";

export default async function BookingsBySourcePage() {
  await assertPermissionPage({ resource: "reports.bookings_by_source", action: "read" });
  return <BookingsBySourceView />;
}
