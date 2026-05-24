// BP36 §33.5 — request shape for /api/ingest/reference.
//
// Trusted batch reference content (CruiseMapper ship + port pages, etc.).
// Bypasses the human-review queue. Idempotent by source_identifier (the
// scraper's deterministic key, e.g. 'cruisemapper:ship:symphony-of-the-seas').
//
// Distinct from /api/ingest/itinerary which writes a sibling itineraries
// row; reference ingest writes only to knowledge_chunks.

import { z } from "zod";

export const ReferenceIngestRequestSchema = z.object({
  source_identifier: z.string().min(8).max(200), // e.g. 'cruisemapper:ship:<slug>'
  category: z.string().min(1),                   // 'ship_intel' | 'port_intel' | future
  text: z.string().min(20),
  source_url: z.string().url().optional(),
  source_domain: z.string().optional(),
  authority: z.number().min(0).max(1).optional(),
  cruise_line: z.string().optional(),
  ship: z.string().optional(),
  destination: z.string().optional(),
});

export type ReferenceIngestRequest = z.infer<typeof ReferenceIngestRequestSchema>;
