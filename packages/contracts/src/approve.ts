// POST /api/approve/{tenant,global} — main → rag.
// Spec: §8.5 (tenant approval), §6.7 (global promotion).

import { z } from "zod";

const UUID = z.string().uuid();

export const ApproveRequestSchema = z.object({
  queue_item_id: UUID,
  edits: z
    .object({
      content: z.string().optional(),
      category: z.string().optional(),
      source_url: z.string().url().optional(),
      authority_override: z.number().min(0).max(1).optional(),
      authority_override_reason: z.string().optional(),
      expires_at: z.string().datetime().optional(),
    })
    .optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;
