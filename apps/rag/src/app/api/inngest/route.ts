/** RAG service Inngest serve endpoint */

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tenantRegistryReconcile } from "@/inngest/tenant-registry-reconcile";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [tenantRegistryReconcile],
});
