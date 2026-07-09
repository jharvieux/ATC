-- =============================================================================
-- 1632-dedup-before-unique-constraints.sql
-- =============================================================================
-- Purpose: reconcile PRE-EXISTING duplicate rows in three tables so the UNIQUE
--          indexes added by migration 20260721000000 (#1575 / PR #1630) apply
--          cleanly to prod. Those indexes are:
--            • commissions (booking_id)
--            • bookings (tenant_id, provider_booking_ref) WHERE origin='imported'
--            • contacts  (tenant_id, lower(email))         WHERE email IS NOT NULL
--          If prod holds a duplicate in any of these, the matching
--          CREATE UNIQUE INDEX fails loud with SQLSTATE 23505 and blocks the
--          gated prod apply. This script clears the blockers (contacts,
--          imported bookings) and REPORTS the money-sensitive ones (commissions)
--          for manual reconciliation.
--
-- ⚠️  DO NOT run this against production or staging directly. It is operator
--     work for the gated prod-apply step. The intended workflow is:
--       1. Restore a PROD SNAPSHOT into a throwaway database.
--       2. Run this in DRY-RUN (default) and review the reported duplicates.
--       3. For commissions: reconcile each against the payout ledger by hand
--          (this overlaps the #1577 / #1576 / #1578 cascade). NEVER blind-delete.
--       4. Re-run with -v apply=1 for contacts + imported-bookings dedup only,
--          inside the same session, and confirm the verification block reports
--          zero remaining duplicates (i.e. the three CREATE UNIQUE INDEX would
--          now succeed).
--
-- Idempotent: DRY-RUN mutates nothing. The apply path keeps the earliest
-- (survivor) row per duplicate key and repoints EVERY foreign-key referencer to
-- it before deleting the losers, so re-running finds nothing left to collapse.
--
-- Run:
--   Dry-run (default, report only):
--     psql "$SNAPSHOT_DB_URL" -f scripts/1632-dedup-before-unique-constraints.sql
--   Apply (contacts + imported bookings only; commissions stays report-only):
--     psql "$SNAPSHOT_DB_URL" -v apply=1 -f scripts/1632-dedup-before-unique-constraints.sql
--
-- Survivor rule: earliest created_at wins (tie-break: smallest id). Keeping the
-- oldest row preserves the original attribution/history and matches the
-- upsert-first-writer intent of the affected write paths.
-- =============================================================================

\set ON_ERROR_STOP on
-- Default apply=0 (dry-run) unless the caller passes -v apply=1.
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;

-- Wrap the whole run in a savepoint-free transaction. In dry-run we ROLLBACK at
-- the end; in apply we COMMIT. Either way a mid-run error aborts cleanly.

-- ---------------------------------------------------------------------------
-- Helper: repoint every FK column that references <target table>.<id> from a
-- set of "loser" ids to a "survivor" id, discovered dynamically from the
-- catalog so no referencer is missed (the issue notes ~15 FK tables across
-- ON DELETE CASCADE / SET NULL). Runs only when apply=1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.repoint_fks(
  p_target_table regclass,
  p_survivor uuid,
  p_losers uuid[]
) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  r RECORD;
  child_table text;
  child_col   text;
  updated integer;
BEGIN
  FOR r IN
    SELECT
      con.conrelid::regclass::text AS child_table,
      att.attname                  AS child_col
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = con.conkey[1]      -- these are all single-column FKs
    WHERE con.contype = 'f'
      AND con.confrelid = p_target_table
      AND array_length(con.conkey, 1) = 1
  LOOP
    child_table := r.child_table;
    child_col   := r.child_col;
    EXECUTE format(
      'UPDATE %s SET %I = $1 WHERE %I = ANY($2)',
      child_table, child_col, child_col
    ) USING p_survivor, p_losers;
    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated > 0 THEN
      RAISE NOTICE '  repointed % row(s) in %.% → survivor %',
        updated, child_table, child_col, p_survivor;
    END IF;
  END LOOP;
END;
$fn$;

-- ===========================================================================
-- 1. contacts — collapse (tenant_id, lower(email))
-- ===========================================================================
-- Duplicate groups: same tenant, same case-folded email, >1 row. Survivor =
-- earliest created_at. Losers get their FK referencers repointed, then deleted.
-- ===========================================================================
\echo ''
\echo '=== 1. contacts (tenant_id, lower(email)) duplicates ==='

WITH grouped AS (
  SELECT
    id, tenant_id, lower(email) AS email_key, created_at,
    first_value(id) OVER w AS survivor_id,
    count(*)        OVER (PARTITION BY tenant_id, lower(email)) AS grp_size
  FROM public.contacts
  WHERE email IS NOT NULL
  WINDOW w AS (
    PARTITION BY tenant_id, lower(email)
    ORDER BY created_at ASC, id ASC
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
)
SELECT tenant_id, email_key, grp_size AS rows_in_group,
       survivor_id, id AS loser_id
FROM grouped
WHERE grp_size > 1 AND id <> survivor_id
ORDER BY tenant_id, email_key;

\if :apply
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT survivor_id, array_agg(id) AS loser_ids
    FROM (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY tenant_id, lower(email)
               ORDER BY created_at ASC, id ASC
             ) AS survivor_id,
             count(*) OVER (PARTITION BY tenant_id, lower(email)) AS grp_size
      FROM public.contacts
      WHERE email IS NOT NULL
    ) s
    WHERE grp_size > 1 AND id <> survivor_id
    GROUP BY survivor_id
  LOOP
    RAISE NOTICE 'contacts: collapsing % loser(s) into survivor %',
      array_length(g.loser_ids, 1), g.survivor_id;
    PERFORM pg_temp.repoint_fks('public.contacts'::regclass, g.survivor_id, g.loser_ids);
    DELETE FROM public.contacts WHERE id = ANY(g.loser_ids);
  END LOOP;
END $$;
\endif

-- ===========================================================================
-- 2. bookings (imported) — collapse (tenant_id, provider_booking_ref)
-- ===========================================================================
-- Only origin='imported' rows are constrained by the new partial UNIQUE index.
-- Survivor = earliest created_at. Repoint commissions + all other booking
-- referencers, then delete losers.
-- ===========================================================================
\echo ''
\echo '=== 2. bookings imported (tenant_id, provider_booking_ref) duplicates ==='

WITH grouped AS (
  SELECT
    id, tenant_id, provider_booking_ref, created_at,
    first_value(id) OVER (
      PARTITION BY tenant_id, provider_booking_ref
      ORDER BY created_at ASC, id ASC
    ) AS survivor_id,
    count(*) OVER (PARTITION BY tenant_id, provider_booking_ref) AS grp_size
  FROM public.bookings
  WHERE origin = 'imported' AND provider_booking_ref IS NOT NULL
)
SELECT tenant_id, provider_booking_ref, grp_size AS rows_in_group,
       survivor_id, id AS loser_id
FROM grouped
WHERE grp_size > 1 AND id <> survivor_id
ORDER BY tenant_id, provider_booking_ref;

\if :apply
DO $$
DECLARE
  g RECORD;
BEGIN
  FOR g IN
    SELECT survivor_id, array_agg(id) AS loser_ids
    FROM (
      SELECT id,
             first_value(id) OVER (
               PARTITION BY tenant_id, provider_booking_ref
               ORDER BY created_at ASC, id ASC
             ) AS survivor_id,
             count(*) OVER (PARTITION BY tenant_id, provider_booking_ref) AS grp_size
      FROM public.bookings
      WHERE origin = 'imported' AND provider_booking_ref IS NOT NULL
    ) s
    WHERE grp_size > 1 AND id <> survivor_id
    GROUP BY survivor_id
  LOOP
    RAISE NOTICE 'bookings(imported): collapsing % loser(s) into survivor %',
      array_length(g.loser_ids, 1), g.survivor_id;
    -- NB: commissions is a booking referencer; repointing moves any
    -- commission rows onto the survivor. If that in turn creates a
    -- commissions(booking_id) duplicate, section 3 below will surface it —
    -- do NOT proceed to the commissions UNIQUE index until section 3 is clean.
    PERFORM pg_temp.repoint_fks('public.bookings'::regclass, g.survivor_id, g.loser_ids);
    DELETE FROM public.bookings WHERE id = ANY(g.loser_ids);
  END LOOP;
END $$;
\endif

-- ===========================================================================
-- 3. commissions (booking_id) — REPORT ONLY (money-sensitive)
-- ===========================================================================
-- Duplicate commission rows for one booking almost certainly already produced
-- double payout_records / Stripe transfers. This script MUST NOT delete them:
-- each duplicate has to be reconciled against its payout ledger and the extra
-- transfer clawed back/voided by the operator BEFORE the row is removed. This
-- block reports each duplicate group with its payout linkage so the operator
-- can reconcile. No apply path — deletion is deliberately manual.
-- ===========================================================================
\echo ''
\echo '=== 3. commissions (booking_id) duplicates — REPORT ONLY, reconcile by hand ==='

SELECT
  c.booking_id,
  count(*) OVER (PARTITION BY c.booking_id) AS commission_rows_for_booking,
  c.id            AS commission_id,
  c.status        AS commission_status,
  c.created_at,
  pr.id           AS payout_record_id,
  pr.status       AS payout_status,
  pr.stripe_transfer_id
FROM public.commissions c
LEFT JOIN public.payout_records pr ON pr.commission_id = c.id
WHERE c.booking_id IN (
  SELECT booking_id FROM public.commissions
  GROUP BY booking_id HAVING count(*) > 1
)
ORDER BY c.booking_id, c.created_at, c.id;

-- ===========================================================================
-- 4. Verification — would the three CREATE UNIQUE INDEX statements succeed?
-- ===========================================================================
-- Each count must be 0 for its index to apply. In dry-run, commissions and any
-- table with un-applied dedup will still show >0 (expected). In apply mode,
-- contacts + imported-bookings must be 0; commissions is 0 only after manual
-- reconciliation.
-- ===========================================================================
\echo ''
\echo '=== 4. Remaining constraint-violating duplicate groups (target: 0 each) ==='

SELECT 'contacts' AS table_name,
       count(*) AS violating_groups
FROM (
  SELECT 1 FROM public.contacts
  WHERE email IS NOT NULL
  GROUP BY tenant_id, lower(email) HAVING count(*) > 1
) x
UNION ALL
SELECT 'bookings_imported',
       count(*)
FROM (
  SELECT 1 FROM public.bookings
  WHERE origin = 'imported' AND provider_booking_ref IS NOT NULL
  GROUP BY tenant_id, provider_booking_ref HAVING count(*) > 1
) x
UNION ALL
SELECT 'commissions',
       count(*)
FROM (
  SELECT 1 FROM public.commissions
  GROUP BY booking_id HAVING count(*) > 1
) x;

-- ---------------------------------------------------------------------------
-- Commit only when applying; dry-run rolls everything back.
-- ---------------------------------------------------------------------------
\if :apply
  \echo ''
  \echo '>>> apply=1 — COMMITTING contacts + imported-bookings dedup.'
  COMMIT;
\else
  \echo ''
  \echo '>>> dry-run (default) — ROLLBACK, nothing changed. Re-run with -v apply=1 to apply.'
  ROLLBACK;
\endif
