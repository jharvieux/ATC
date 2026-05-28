// §27.12 — Per-purpose batch flush.
//
// Each purpose has its own flush cron because the right cadence differs:
//   - precruise_generation: daily at 9:30 UTC (right after the
//     pre-cruise-multiphase-daily-batched scheduler enqueues)
//   - memory_extraction: hourly (steady trickle of events from
//     transfer-finalize; flush regularly so memory becomes available
//     within an hour of the conversation ending)
//
// Other purposes (RAG ingest enrichment / P3 #33) are not yet wired as
// producers — when they migrate, add their flush function here with
// the right cadence.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { flushPendingForPurpose } from "@/lib/ai/batch/flush";

export const aiBatchFlushPrecruise = inngest.createFunction(
  {
    id: "ai-batch-flush-precruise",
    triggers: [{ cron: "30 9 * * *" }], // daily 9:30 UTC
    concurrency: { limit: 1 },
  },
  async () => {
    const db = createServiceRoleClient();
    const result = await flushPendingForPurpose({
      purpose: "precruise_generation",
      db,
    });
    return result;
  },
);

export const aiBatchFlushMemoryExtraction = inngest.createFunction(
  {
    id: "ai-batch-flush-memory-extraction",
    triggers: [{ cron: "0 * * * *" }], // hourly at minute 0
    concurrency: { limit: 1 },
  },
  async () => {
    const db = createServiceRoleClient();
    const result = await flushPendingForPurpose({
      purpose: "memory_extraction",
      db,
    });
    return result;
  },
);

// Persona-addendum screening fires on every save but volume is low —
// most tenants edit the addendum a handful of times. A 30-minute flush
// is fine: the tenant UI already says "screening in progress" so the
// extra latency is invisible, and 30 min is well inside the "before
// next persona edit" window.
export const aiBatchFlushPersonaAddendumScreen = inngest.createFunction(
  {
    id: "ai-batch-flush-persona-addendum-screen",
    triggers: [{ cron: "*/30 * * * *" }], // every 30 minutes
    concurrency: { limit: 1 },
  },
  async () => {
    const db = createServiceRoleClient();
    const result = await flushPendingForPurpose({
      purpose: "persona_addendum_screen",
      db,
    });
    return result;
  },
);
