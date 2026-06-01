import { redirect } from "next/navigation";

export default function AdminRootPage() {
  redirect("/admin/tenants/review-queue");
}
