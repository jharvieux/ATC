import { assertPlatformRolePage } from "@/lib/auth/assert-platform-admin";
import ClientPage from "./_client";

export const dynamic = "force-dynamic";

export default async function CruiseCatalogPage() {
  await assertPlatformRolePage(["superadmin", "reviewer"]);
  return <ClientPage />;
}
