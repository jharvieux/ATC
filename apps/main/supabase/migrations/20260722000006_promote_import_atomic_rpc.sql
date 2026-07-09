-- Migration: promote_import_atomic_rpc
-- Version:   20260722000006
-- Generated: 2026-07-09T18:57:05Z by scripts/new-migration.sh
-- Branch:    feature/sweep-import2-1711
-- Worktree:  agent-ab715c763a6165a9b
--
-- #1712 (folds in #1711) — collapse the import-promote write sequence into ONE
-- atomic transaction.
--
-- Before this, apps/main/src/lib/import/promote.ts drove promotion as a chain of
-- separate supabase-js mutations: CAS-claim the queue row to 'promoting', insert
-- contact, checkpoint promoted_contact_id, insert booking, checkpoint
-- promoted_booking_id, insert commission, insert contact_imports, finalize the
-- queue row to 'accepted'. Each insert+checkpoint pair was individually
-- idempotent, but the booking path's contact/booking inserts carry null dedup
-- keys (email/phone null; provider_booking_ref frequently null on the document
-- path), so the DB unique indexes from #1630 don't cover them. If the Inngest
-- promote step died between an insert committing and its checkpoint committing,
-- the resumed step re-read a null checkpoint and inserted again → an orphaned
-- duplicate contact/booking in the CRM (#1711).
--
-- This RPC eliminates that crash window BY CONSTRUCTION: the claim, all three
-- record inserts, the contact_imports audit row, and the finalize run inside one
-- plpgsql function = one transaction. Either every write commits or none does;
-- there is no intermediate state a retry can observe, so no per-step checkpoints
-- and no null-key duplicate window. Concurrency is handled by SELECT ... FOR
-- UPDATE on the queue row: a second concurrent promote (double-click / two
-- agents / a whole-step Inngest retry) blocks until the first commits, then reads
-- status='accepted' and returns the already-promoted ids idempotently — it never
-- re-runs the inserts.
--
-- App-layer stays responsible for everything that needs I/O or business logic
-- outside a transaction: the sub-host tenant-type block, commission-rate
-- resolution (host-adapter lookup + §34.7.3 fall-through), canonical line/ship
-- resolution, and the audit_log write. Those feed resolved scalar values into
-- this function; the function only writes.
--
-- Contact dedup mirrors the old upsertContact: look up by (tenant_id, email)
-- then (tenant_id, phone); on a lost race with a *different* import row promoting
-- the same email concurrently, the unique_violation handler adopts the existing
-- contact (matched case-insensitively against the contacts_tenant_email_uidx
-- lower(email) index). Booking/commission inserts get the same adopt-on-conflict
-- guard for their #1630 unique indexes, though within one locked-queue-row
-- transaction they can only fire once.
--
-- SECURITY DEFINER with an empty search_path (every object schema-qualified), so
-- the service-role caller runs it under the definer role; EXECUTE revoked from
-- PUBLIC and granted only to service_role. Function EXECUTE grants are not
-- captured by db/grants-snapshot-main.sql (it snapshots table/sequence grants
-- only), and no policy is touched, so no snapshot regen is required.

CREATE OR REPLACE FUNCTION public.promote_import(
  p_queue_row_id           uuid,
  p_tenant_id              uuid,
  p_claimable_statuses     text[],
  p_document_type          text,
  -- contact_imports audit-row inputs
  p_import_path            text,
  p_source_ref             text,
  p_confidence             numeric,
  p_raw_extracted_fields   jsonb,
  p_accepting_user_id      uuid,
  p_submitted_by_user_id   uuid,
  -- contact
  p_contact_first_name     text,
  p_contact_last_name      text,
  p_contact_email          text,
  p_contact_phone          text,
  p_contact_source_ref     text,
  p_contact_notes          text,
  -- booking (used only when p_is_booking)
  p_is_booking             boolean,
  p_cruise_line            text,
  p_ship_name              text,
  p_sailing_date           date,
  p_duration_nights        integer,
  p_departure_port         text,
  p_cabin_category         text,
  p_total_amount_cents     bigint,
  p_currency               text,
  p_provider_booking_ref   text,
  p_cruise_line_id         uuid,
  p_cruise_ship_id         uuid,
  -- commission
  p_commission_rate        numeric,
  p_commission_rate_source text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status        text;
  v_contact_id    uuid;
  v_booking_id    uuid;
  v_commission_id uuid;
  v_prev_contact  uuid;
  v_prev_booking  uuid;
  v_commissionable bigint;
  v_gross         bigint;
  v_currency      text := COALESCE(p_currency, 'USD');
BEGIN
  -- Lock the queue row for the duration of the transaction. A concurrent
  -- promote of the same row blocks here until we commit, then re-reads
  -- status='accepted' below and returns idempotently instead of re-inserting.
  SELECT status, promoted_contact_id, promoted_booking_id
    INTO v_status, v_prev_contact, v_prev_booking
    FROM public.import_queue
   WHERE id = p_queue_row_id
     AND tenant_id = p_tenant_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- A prior promotion already finished. Return its records (no commission_id:
  -- the queue row doesn't carry it, and the idempotent caller path doesn't need
  -- it — matches the pre-RPC already_accepted return shape).
  IF v_status = 'accepted' THEN
    RETURN jsonb_build_object(
      'status', 'already_accepted',
      'contact_id', v_prev_contact,
      'booking_id', v_prev_booking
    );
  END IF;

  -- Not claimable and not already done → the row is in a state promotion can't
  -- act on (rejected / parse_failed / mid-pipeline). Report the live status.
  IF NOT (v_status = ANY (p_claimable_statuses)) THEN
    RETURN jsonb_build_object('status', 'conflict', 'row_status', v_status);
  END IF;

  -- ── contact ──────────────────────────────────────────────────────────────
  -- §34.3.4 dedup on (tenant_id, email) then (tenant_id, phone).
  IF p_contact_email IS NOT NULL THEN
    SELECT id INTO v_contact_id
      FROM public.contacts
     WHERE tenant_id = p_tenant_id AND email = p_contact_email
     LIMIT 1;
  END IF;
  IF v_contact_id IS NULL AND p_contact_phone IS NOT NULL THEN
    SELECT id INTO v_contact_id
      FROM public.contacts
     WHERE tenant_id = p_tenant_id AND phone = p_contact_phone
     LIMIT 1;
  END IF;

  IF v_contact_id IS NULL THEN
    BEGIN
      INSERT INTO public.contacts (
        tenant_id, first_name, last_name, email, phone,
        source, source_reference, notes
      ) VALUES (
        p_tenant_id, p_contact_first_name, p_contact_last_name,
        p_contact_email, p_contact_phone,
        'imported', p_contact_source_ref, p_contact_notes
      )
      RETURNING id INTO v_contact_id;
    EXCEPTION WHEN unique_violation THEN
      -- A different import row won the (tenant_id, lower(email)) unique index
      -- (#1630) between our lookup and insert. Adopt the existing contact.
      SELECT id INTO v_contact_id
        FROM public.contacts
       WHERE tenant_id = p_tenant_id
         AND lower(email) = lower(p_contact_email)
       LIMIT 1;
      IF v_contact_id IS NULL THEN
        RAISE;
      END IF;
    END;
  END IF;

  -- ── booking + commission (booking_confirmation only) ──────────────────────
  IF p_is_booking THEN
    BEGIN
      INSERT INTO public.bookings (
        tenant_id, primary_contact_id, booking_type,
        cruise_line, ship_name, sailing_date, duration_nights,
        departure_port, cabin_category,
        total_amount_cents, commissionable_fare_cents, currency,
        origin, imported_from, imported_at, imported_by_user_id,
        provider_booking_ref, status,
        cruise_line_id, cruise_ship_id
      ) VALUES (
        p_tenant_id, v_contact_id, 'cruise',
        p_cruise_line, p_ship_name, p_sailing_date, p_duration_nights,
        p_departure_port, p_cabin_category,
        p_total_amount_cents, p_total_amount_cents, v_currency,
        'imported', p_import_path, now(), p_accepting_user_id,
        p_provider_booking_ref, 'confirmed',
        p_cruise_line_id, p_cruise_ship_id
      )
      RETURNING id INTO v_booking_id;
    EXCEPTION WHEN unique_violation THEN
      -- Lost the (tenant_id, provider_booking_ref) imported-booking unique index
      -- (#1630) to a concurrent import row. Adopt the existing booking.
      SELECT id INTO v_booking_id
        FROM public.bookings
       WHERE tenant_id = p_tenant_id
         AND provider_booking_ref = p_provider_booking_ref
         AND origin = 'imported'
       LIMIT 1;
      IF v_booking_id IS NULL THEN
        RAISE;
      END IF;
    END;

    -- §34.7.2 — exactly one commission row per booking (commissions.booking_id
    -- UNIQUE, #1630). This is the innermost double-payout guard.
    SELECT id INTO v_commission_id
      FROM public.commissions
     WHERE tenant_id = p_tenant_id AND booking_id = v_booking_id
     LIMIT 1;

    IF v_commission_id IS NULL THEN
      v_commissionable := COALESCE(p_total_amount_cents, 0);
      -- Money invariant (#1658): *_cents are already in the currency's ISO-4217
      -- minor unit — never re-scale. round() matches JS Math.round for the
      -- positive product here.
      v_gross := round(v_commissionable * p_commission_rate);
      BEGIN
        INSERT INTO public.commissions (
          tenant_id, booking_id, commissionable_fare_cents,
          commission_rate, platform_split_rate, gross_commission_cents,
          host_booking_fee_cents, net_commission_cents,
          platform_retained_cents, subhost_payable_cents,
          currency, status, commission_rate_source
        ) VALUES (
          p_tenant_id, v_booking_id, v_commissionable,
          p_commission_rate, 0, v_gross,
          0, v_gross,
          0, 0,
          v_currency, 'expected', p_commission_rate_source
        )
        RETURNING id INTO v_commission_id;
      EXCEPTION WHEN unique_violation THEN
        SELECT id INTO v_commission_id
          FROM public.commissions
         WHERE tenant_id = p_tenant_id AND booking_id = v_booking_id
         LIMIT 1;
        IF v_commission_id IS NULL THEN
          RAISE;
        END IF;
      END;
    END IF;
  END IF;

  -- ── contact_imports audit row ─────────────────────────────────────────────
  -- No dedup lookup: the FOR UPDATE lock + single transaction means this runs
  -- exactly once per promote (the pre-RPC lookup-first dedup only existed to
  -- cover a mid-sequence retry, which can no longer happen).
  INSERT INTO public.contact_imports (
    tenant_id, contact_id, import_path, source_ref,
    document_type, confidence, imported_by_user_id, raw_extracted_fields
  ) VALUES (
    p_tenant_id, v_contact_id, p_import_path, p_source_ref,
    COALESCE(p_document_type, 'unknown'), p_confidence,
    COALESCE(p_accepting_user_id, p_submitted_by_user_id),
    p_raw_extracted_fields
  );

  -- ── finalize the queue row ────────────────────────────────────────────────
  -- §34.4 — 24h retention on accepted rows; the purge cron sweeps after.
  UPDATE public.import_queue
     SET status              = 'accepted',
         accepted_at         = now(),
         promoted_contact_id = v_contact_id,
         promoted_booking_id = v_booking_id,
         purgable_at         = now() + interval '24 hours'
   WHERE id = p_queue_row_id
     AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'status', 'promoted',
    'contact_id', v_contact_id,
    'booking_id', v_booking_id,
    'commission_id', v_commission_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.promote_import(
  uuid, uuid, text[], text, text, text, numeric, jsonb, uuid, uuid,
  text, text, text, text, text, text,
  boolean, text, text, date, integer, text, text, bigint, text, text, uuid, uuid,
  numeric, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_import(
  uuid, uuid, text[], text, text, text, numeric, jsonb, uuid, uuid,
  text, text, text, text, text, text,
  boolean, text, text, date, integer, text, text, bigint, text, text, uuid, uuid,
  numeric, text
) TO service_role;

COMMENT ON FUNCTION public.promote_import(
  uuid, uuid, text[], text, text, text, numeric, jsonb, uuid, uuid,
  text, text, text, text, text, text,
  boolean, text, text, date, integer, text, text, bigint, text, text, uuid, uuid,
  numeric, text
) IS
  '#1712 (#1711): atomically promotes an import_queue row — claim (FOR UPDATE), dedup/insert contact, insert booking+commission (booking path), write contact_imports, finalize to accepted — in one transaction. Returns jsonb {status: promoted|already_accepted|conflict|not_found, contact_id, booking_id, commission_id}. Eliminates the insert/checkpoint crash window that could orphan duplicate contacts/bookings.';

-- #1712 heal-at-cutover: this PR removes the last writer of status 'promoting'
-- (and the old unclaim path), so any row stranded in 'promoting' from the
-- pre-RPC flow would be permanently un-promotable — the RPC only claims from
-- pending_review/pending_validation and returns 'conflict' (→ 500 forever) for
-- anything else. Reset stranded rows back to pending_review so they re-enter the
-- claimable set. NOTE: removing 'promoting' from import_queue_status_check itself
-- is deferred to the contract migration in #1754.
UPDATE public.import_queue SET status = 'pending_review' WHERE status = 'promoting';

