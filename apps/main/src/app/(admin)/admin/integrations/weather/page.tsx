// §23.4 — Weather monitoring moved to the resource utilization dashboard.
// Redirect so any existing bookmarks continue to work.

import { redirect } from "next/navigation";

export default function WeatherPageRedirect() {
  redirect("/admin/resources");
}
