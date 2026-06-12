import { assertPlatformRolePage } from "@/lib/auth/assert-platform-admin";
import ClientPage from "./_client";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  await assertPlatformRolePage(["superadmin", "finance", "support"]);
  return <ClientPage />;
}
