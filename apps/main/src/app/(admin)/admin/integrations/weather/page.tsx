// §23.4 — Weather monitoring moved to the resource utilization dashboard.
// Redirect so any existing bookmarks continue to work.

import { redirect } from "next/navigation";
import { assertPlatformRolePage } from "@/lib/auth/assert-platform-admin";

export const dynamic = "force-dynamic";

export default async function WeatherPageRedirect() {
  await assertPlatformRolePage(["superadmin"]);
  redirect("/admin/resources");
}
