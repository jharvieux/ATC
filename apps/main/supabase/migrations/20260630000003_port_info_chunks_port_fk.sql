-- #780 Phase 1 — link port_info_chunks to canonical ports table.
--
-- Expand step only. Adds a nullable port_id FK to port_info_chunks so the
-- canonical ports table becomes the join target while existing content data
-- stays intact. NULL means not yet reconciled; populated by the port ingest
-- scraper or a one-time backfill.

ALTER TABLE public.port_info_chunks
  ADD COLUMN IF NOT EXISTS port_id uuid REFERENCES public.ports(id);

CREATE INDEX IF NOT EXISTS port_info_chunks_port_id_idx
  ON public.port_info_chunks (port_id)
  WHERE port_id IS NOT NULL;

-- Back-fill: match on canonical_name = port_name (case-insensitive).
UPDATE public.port_info_chunks pic
SET port_id = p.id
FROM public.ports p
WHERE pic.port_id IS NULL
  AND lower(trim(p.canonical_name)) = lower(trim(pic.port_name));
