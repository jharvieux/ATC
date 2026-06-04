/** RAG service Inngest serve endpoint */
export const dynamic = "force-dynamic";

import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tenantRegistryReconcile } from "@/inngest/tenant-registry-reconcile";
import { platformSettingsReconcile } from "@/inngest/platform-settings-reconcile";
// §6.7 — promo state reconciliation + drift alert
import { promoStateReconcile } from "@/inngest/promo-state-reconcile";
import { promoStateDriftAlert } from "@/inngest/promo-state-drift-alert";
// §6.12 — retrieval log aggregation + 90-day purge
import { retrievalLogAggregate } from "@/inngest/retrieval-log-aggregate";
// #686 — OpenAI embedding batch pipeline
import { openaiEmbeddingFlush } from "@/inngest/openai-embedding-flush";
import { openaiEmbeddingReconcile } from "@/inngest/openai-embedding-reconcile";
import { openaiEmbeddingStaleAlert } from "@/inngest/openai-embedding-stale-alert";

// 2026-05-25 RAG audit Finding 5 (defense-in-depth): make the signing-key
// requirement explicit instead of relying on the SDK's silent env-var read.
// If INNGEST_SIGNING_KEY is missing in production the SDK accepts unauthenticated
// POSTs to /api/inngest, which would let an external caller fire any
// registered function on demand. Pass it explicitly so a missing value is
// loud rather than silent.
//
// NEXT_PHASE === "phase-production-build" lets `next build` collect page data
// without runtime secrets. The same module evaluates again at server boot
// (NEXT_PHASE !== "phase-production-build") where the throw is what we want.
const signingKey = process.env.INNGEST_SIGNING_KEY;
if (
  !signingKey &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error(
    "INNGEST_SIGNING_KEY must be set in production. " +
      "Without it, /api/inngest accepts unauthenticated function invocations.",
  );
}

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    tenantRegistryReconcile,
    platformSettingsReconcile,
    promoStateReconcile,
    promoStateDriftAlert,
    retrievalLogAggregate,
    openaiEmbeddingFlush,
    openaiEmbeddingReconcile,
    openaiEmbeddingStaleAlert,
  ],
  ...(signingKey ? { signingKey } : {}),
});
