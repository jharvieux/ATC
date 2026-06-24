// BP37 §33.6 — request shape for /api/admin/media-assets/upsert.

import { z } from "zod";
import { safeUrl } from "@atc/contracts";

export const MediaAssetUpsertSchema = z.object({
  kind: z.enum(["deck_plan", "ship_photo", "port_map", "other"]),
  entity_type: z.enum(["ship", "port", "deck", "cruise_line"]),
  entity_id: z.string().min(1).max(200),
  scope: z.enum(["global", "tenant"]),
  tenant_id: z.string().uuid().optional(),
  image_url: safeUrl,
  source_page_url: safeUrl,
  attribution: z.string().min(1),
  caption: z.string().nullable().optional(),
  content_type: z.string().nullable().optional(),
  width_px: z.number().int().positive().nullable().optional(),
  height_px: z.number().int().positive().nullable().optional(),
  source: z.string().min(1),
});

export type MediaAssetUpsertRequest = z.infer<typeof MediaAssetUpsertSchema>;
