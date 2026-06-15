// §23.4 — Weather monitoring moved to the resource utilization dashboard.
// Redirect so any existing bookmarks continue to work.

import { redirect } from "next/navigation";
import { assertPlatformAdminAreaPage } from "@/lib/auth/assert-platform-admin";

export const dynamic = "force-dynamic";

export default async function WeatherPageRedirect() {
  await assertPlatformAdminAreaPage("integrations");
  redirect("/admin/resources");
}
