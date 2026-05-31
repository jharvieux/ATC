-- #489 — Add 'admin_sample' and 'travel_news' to email_log.email_category CHECK.
--
-- email_log was seeded with a CHECK constraint listing 4 categories. The
-- TypeScript EmailCategory type already included 'travel_news' (making any
-- travel_news send silently fail at the DB level). 'admin_sample' is new,
-- introduced by the platform-admin email sample page (#489).
--
-- Postgres requires DROP + re-ADD to modify a CHECK constraint.

ALTER TABLE public.email_log
  DROP CONSTRAINT IF EXISTS email_log_email_category_check;

ALTER TABLE public.email_log
  ADD CONSTRAINT email_log_email_category_check CHECK (email_category IN (
    'transactional', 'marketing', 'pre_cruise', 'group_invitation',
    'travel_news', 'admin_sample'
  ));
