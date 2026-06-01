import { redirect } from "next/navigation";

export default function AdminTenantsPage() {
  redirect("/admin/tenants/review-queue");
}
