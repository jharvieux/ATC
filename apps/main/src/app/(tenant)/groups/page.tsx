// §18 — Group bookings list page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks groups:list are
// redirected to "/" before the client shell is sent to the browser.
// This prevents the "page renders, API returns 403, user sees an error
// message" UX described in issue #1406.
//
// The groups:list grant is in READ_GRANTS (permission-grants.ts), which
// covers all authenticated tenant members. The redirect therefore fires
// only for unauthenticated visitors or users with no active membership in
// the resolved tenant — consistent with the sidebar gating this page to
// STAFF roles only (nav-sections.ts).

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { GroupsView } from "./_components/GroupsView";

export default async function GroupBookingsPage() {
  await assertPermissionPage({ resource: "groups", action: "list" });
  return <GroupsView />;
}
