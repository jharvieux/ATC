// #1728 Phase 2 — platform-admin UI for inbound persona-address emails.
// Server shell: the page-level area gate (belt to the (admin) layout's braces,
// D-091 #15). Data comes from GET /api/admin/inbound-emails, which asserts the
// same "email_samples" area in its own handler.

import { assertPlatformAdminAreaPage } from "@/lib/auth/assert-platform-admin";
import InboundEmailsClient from "./_client";

export const dynamic = "force-dynamic";

export default async function InboundEmailsPage() {
  await assertPlatformAdminAreaPage("email_samples");
  return <InboundEmailsClient />;
}
