// BP35 §33.4 — request shape for /api/ingest/itinerary.
//
// Trusted batch reference data — bypasses the human-review queue. Caller
// must be platform-admin (enforced by route). Idempotent on
// (cruise_line, ship, departure_date, departure_port) via UNIQUE +
// content_hash short-circuit.

import { z } from "zod";

export const ItineraryIngestRequestSchema = z.object({
  cruise_line: z.string().min(1),
  ship: z.string().min(1),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure_port: z.string().min(1),
  duration_nights: z.number().int().positive(),
  ports_of_call: z.array(z.string()).default([]),
  region: z.string().optional(),
  starting_price_usd: z.number().nonnegative().optional(),
  source_url: z.string().url().optional(),
  text: z.string().min(20), // chunk body — §B.5 sized prose
  fetched_at: z.string().datetime().optional(),
});

export type ItineraryIngestRequest = z.infer<typeof ItineraryIngestRequestSchema>;
