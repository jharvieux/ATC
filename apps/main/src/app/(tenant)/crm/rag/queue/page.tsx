// §22.5 — CRM RAG submission review queue page.
//
// Server component wrapper: assertPermissionPage gates the render so
// unauthenticated callers and those whose role lacks rag_submissions:review are
// redirected to "/" before the client shell is sent to the browser.
// rag_submissions:review is in OWNER_GRANTS (owner-only), matching the
// GET /api/rag/queue gate.

import { assertPermissionPage } from "@/lib/auth/assert-permission-page";
import { RagQueueView } from "./_components/RagQueueView";

export default async function RagQueuePage() {
  await assertPermissionPage({ resource: "rag_submissions", action: "review" });
  return <RagQueueView />;
}
