-- D-091 Round-2 Pattern 10 (imports half) — dedup index on email-path
-- import_queue rows.
--
-- Background: a Gmail Pub/Sub redelivery hits the webhook, which calls
-- processGmailInboundMessage(), which inserts a NEW import_queue row
-- with the same Gmail message_id as the source_ref. Without a dedup
-- guard the pipeline runs the import twice, potentially creating two
-- contacts/leads from the same email.
--
-- Partial unique index scoped to import_path='email': enforces the
-- (tenant_id, source_ref) uniqueness only for the email path. The
-- document path source_ref is the user-supplied filename and may
-- legitimately repeat (operator uploading two different "invoice.pdf"
-- files). The manual path uses internal form-submission IDs but the
-- same dedup guarantee isn't required there.

CREATE UNIQUE INDEX IF NOT EXISTS import_queue_email_dedup
  ON public.import_queue (tenant_id, source_ref)
  WHERE import_path = 'email';

COMMENT ON INDEX public.import_queue_email_dedup IS
  'D-091 R2 Pattern 10: dedup email-path imports by Gmail message_id. Other paths intentionally allow source_ref duplicates.';
