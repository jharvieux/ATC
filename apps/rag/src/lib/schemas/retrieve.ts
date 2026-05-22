import { z } from "zod";

const UUID = z.string().uuid();

export const RetrieveRequestSchema = z.object({
  query: z.string().min(1),
  tenant_id: UUID,
  user_id: UUID,
  conversation_id: UUID,
  persona_id: UUID,
  filters: z
    .object({
      category: z.string().optional(),
      cruise_line: z.string().optional(),
      ship: z.string().optional(),
      destination: z.string().optional(),
      agent_slug: z.string().optional(),
    })
    .optional()
    .default({}),
  top_k: z.number().int().min(1).max(20).default(10),
  include_closed_promos_for_contact: UUID.nullable().optional().default(null),
});

export type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;

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
