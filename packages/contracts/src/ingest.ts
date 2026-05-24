// POST /api/ingest — main → rag (raw chunk submission for queue).
// Spec: §8.3 (ingest), §6.5 (queue).

import { z } from "zod";

const UUID = z.string().uuid();

export const IngestRequestSchema = z.object({
  source_url: z.string().url().optional(),
  source_domain: z.string().optional(),
  raw_content: z.string().min(1),
  scope: z.enum(["tenant", "global"]),
  tenant_id: UUID,
  category: z.string().min(1),
  cruise_line: z.string().optional(),
  ship: z.string().optional(),
  destination: z.string().optional(),
  agent_scope: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  source_type: z.string().default("manual"),
  contains_pricing: z.boolean().default(false),
});
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

// Response shape (rag → main). Whatever the caller acts on goes here.
export const IngestResponseSchema = z.object({
  queue_item_id: UUID,
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;
