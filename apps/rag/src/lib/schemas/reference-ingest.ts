// BP36 §33.5 — request shape for /api/ingest/reference.
//
// Trusted batch reference content (CruiseMapper ship + port pages, etc.).
// Bypasses the human-review queue. Idempotent by source_identifier (the
// scraper's deterministic key, e.g. 'cruisemapper:ship:symphony-of-the-seas').
//
// Distinct from /api/ingest/itinerary which writes a sibling itineraries
// row; reference ingest writes only to knowledge_chunks.

import { z } from "zod";
import { safeUrl } from "@atc/contracts";

export const ReferenceIngestRequestSchema = z.object({
  source_identifier: z.string().min(8).max(200), // e.g. 'cruisemapper:ship:<slug>'
  category: z.string().min(1),                   // 'ship_intel' | 'port_intel' | future
  text: z.string().min(20),
  source_url: safeUrl.optional(),
  source_domain: z.string().optional(),
  authority: z.number().min(0).max(1).optional(),
  cruise_line: z.string().optional(),
  ship: z.string().optional(),
  destination: z.string().optional(),
  // BP37 §33.6.2 — UUIDs of rag_media_assets rows the new chunk references.
  // Validated for existence + scope compatibility (global chunk → global assets only,
  // tenant chunk → tenant assets of the same tenant).
  related_asset_ids: z.array(z.string().uuid()).optional().default([]),
});

export type ReferenceIngestRequest = z.infer<typeof ReferenceIngestRequestSchema>;
