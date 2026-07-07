-- #1575 — Add missing UNIQUE constraints that three double-payout surfaces
-- assume but the schema never enforced. Under retry/concurrency the current
-- plain indexes let duplicate rows land, and the duplicates cascade into real
-- double Stripe payouts (payout idempotency is keyed per commission_id, so two
-- commission rows for one booking = two payout_records = two transfers).
--
-- Expand-only, additive: these are UNIQUE indexes alongside the existing plain
-- indexes. No CONCURRENTLY (D-306 / migrations runbook §3) — these tables are
-- small and supabase db push runs a file's statements in one pipeline, where
-- CONCURRENTLY errors 25001. No policy or grant is touched, so no RLS/grants
-- snapshot regen is required.
--
-- PROD PREREQUISITE: if a table already holds duplicate rows, the matching
-- CREATE UNIQUE INDEX below fails loud with 23505 naming the offending key.
-- Deduping pre-existing prod rows is money-sensitive (commissions/payouts) and
-- is the operator's job at the gated prod-apply step — see the follow-up issue.
-- On the CI test DB (clean seed data) there are no duplicates, so these apply
-- cleanly. The point of this migration is to stop FUTURE duplicates.

-- ── 1. commissions.booking_id ──────────────────────────────────────────────
-- One commission row per booking is the real invariant: both writers
-- (bookings/[id]/submit and import promote) insert status='expected', and the
-- clawback path updates the existing row in place to 'disputed' — nothing ever
-- creates a second commission row for a booking. So a plain UNIQUE (no partial
-- predicate) is correct and is the strongest double-payout guard.
--
-- NB: #1575 suggested `WHERE status <> 'reversed'`, but commission_status has
-- no 'reversed' value (expected|invoiced|received|partial|overdue|disputed|
-- waived) and no flow produces a superseded second row, so the predicate would
-- add nothing and only weaken the guarantee. Dropped deliberately.
CREATE UNIQUE INDEX IF NOT EXISTS commissions_booking_id_uidx
  ON public.commissions (booking_id);

-- ── 2. imported bookings dedup key ─────────────────────────────────────────
-- bookings_provider_ref_idx (20260616000000) is a plain partial index — it
-- does not stop a re-promotion from double-inserting the same imported booking.
-- Scope the UNIQUE guard to imported rows only: platform-originated refs come
-- from a different adapter/namespace and aren't guaranteed collision-free
-- against imported refs, so constraining across both origins would be unsafe.
-- The existing non-unique index stays for §14.8 statement-matching lookups.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_imported_provider_ref_uidx
  ON public.bookings (tenant_id, provider_booking_ref)
  WHERE provider_booking_ref IS NOT NULL AND origin = 'imported';

-- ── 3. contacts (tenant_id, email) ─────────────────────────────────────────
-- contacts_email_idx (20260524000000) is a plain index. Without a UNIQUE guard,
-- once two duplicates exist upsertContact's .maybeSingle() errors on the lookup,
-- the error is discarded, and every subsequent import inserts ANOTHER duplicate
-- — self-amplifying CRM corruption. Functional index on lower(email) so
-- case-variant addresses collide too. The plain contacts_email_idx stays for
-- the app's case-sensitive .eq("email") lookup.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_email_uidx
  ON public.contacts (tenant_id, lower(email))
  WHERE email IS NOT NULL;
