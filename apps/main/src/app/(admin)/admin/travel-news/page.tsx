import { assertPlatformAdminAreaPage } from "@/lib/auth/assert-platform-admin";
import ClientPage from "./_client";

export const dynamic = "force-dynamic";

export default async function TravelNewsPage() {
  await assertPlatformAdminAreaPage("travel_news");
  return <ClientPage />;
}
