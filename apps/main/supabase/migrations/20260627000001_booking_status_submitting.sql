-- D-091 Round-3 #50/#51 — booking_status += 'submitting'
--
-- Adds an in-flight state for the booking-submit handler's CAS lock.
-- Pattern: `update().eq("id", id).in("status", ["draft"]).select("id")`
-- transitions draft → submitting BEFORE the host adapter call. Concurrent
-- submits hit the 0-row CAS mismatch and refuse rather than double-call
-- the host. On host call success, the handler transitions submitting →
-- submitted. On host call failure, the handler reverts to draft so a
-- retry can happen. A future reconciliation cron will sweep stuck
-- 'submitting' rows older than N minutes back to draft for retry.

ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'submitting' AFTER 'draft';
