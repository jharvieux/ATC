/** RAG service Inngest serve endpoint */
export const dynamic = "force-dynamic";

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tenantRegistryReconcile } from "@/inngest/tenant-registry-reconcile";
import { platformSettingsReconcile } from "@/inngest/platform-settings-reconcile";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [tenantRegistryReconcile, platformSettingsReconcile],
});
