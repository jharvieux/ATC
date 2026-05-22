-- §12 (BP13) — Resolve deferred FKs now that contacts table exists.
-- These were left as bare UUID columns with TODO(contacts-fk) comments in:
--   20260523180000_customer_memories.sql
--   20260521150000_conversations_messages.sql
--   20260521160000_bookings_commissions.sql

ALTER TABLE public.customer_memories
  ADD CONSTRAINT customer_memories_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_primary_contact_id_fkey
  FOREIGN KEY (primary_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
