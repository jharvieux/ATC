-- §27.4 — Move abuse threshold base counts from hardcoded TypeScript maps
-- into tier_definitions columns so the operator can adjust without a deploy.
-- The thresholds.ts code reads from these columns going forward; the env
-- override knobs (ABUSE_*_PERCENT) still apply as multipliers.

ALTER TABLE public.tier_definitions
  ADD COLUMN IF NOT EXISTS chat_base_monthly         INTEGER,
  ADD COLUMN IF NOT EXISTS email_base_daily          INTEGER,
  ADD COLUMN IF NOT EXISTS group_invite_base_monthly INTEGER,
  ADD COLUMN IF NOT EXISTS rag_base_chunks           INTEGER;

-- Seed with the values previously hardcoded in
-- apps/main/src/lib/abuse/thresholds.ts (§27.4.2 / .3 / .4 / .5).
UPDATE public.tier_definitions SET
  chat_base_monthly         = 500,
  email_base_daily          = 50,
  group_invite_base_monthly = 0,
  rag_base_chunks           = 50
WHERE code = 'byo_research';

UPDATE public.tier_definitions SET
  chat_base_monthly         = 2000,
  email_base_daily          = 150,
  group_invite_base_monthly = 500,
  rag_base_chunks           = 200
WHERE code = 'byo_professional';

UPDATE public.tier_definitions SET
  chat_base_monthly         = 5000,
  email_base_daily          = 500,
  group_invite_base_monthly = 2000,
  rag_base_chunks           = 500
WHERE code = 'byo_agency';

UPDATE public.tier_definitions SET
  chat_base_monthly         = 1000,
  email_base_daily          = 100,
  group_invite_base_monthly = 500,
  rag_base_chunks           = 100
WHERE code = 'sub_starter';

UPDATE public.tier_definitions SET
  chat_base_monthly         = 5000,
  email_base_daily          = 500,
  group_invite_base_monthly = 1000,
  rag_base_chunks           = 500
WHERE code = 'sub_pro';

UPDATE public.tier_definitions SET
  chat_base_monthly         = 15000,
  email_base_daily          = 1500,
  group_invite_base_monthly = 2000,
  rag_base_chunks           = 2000
WHERE code = 'sub_agency';

-- Belt-and-suspenders: backstop any future tier rows that miss a seed.
UPDATE public.tier_definitions SET
  chat_base_monthly         = COALESCE(chat_base_monthly, 0),
  email_base_daily          = COALESCE(email_base_daily, 0),
  group_invite_base_monthly = COALESCE(group_invite_base_monthly, 0),
  rag_base_chunks           = COALESCE(rag_base_chunks, 0);

ALTER TABLE public.tier_definitions
  ALTER COLUMN chat_base_monthly         SET NOT NULL,
  ALTER COLUMN email_base_daily          SET NOT NULL,
  ALTER COLUMN group_invite_base_monthly SET NOT NULL,
  ALTER COLUMN rag_base_chunks           SET NOT NULL,
  ALTER COLUMN chat_base_monthly         SET DEFAULT 0,
  ALTER COLUMN email_base_daily          SET DEFAULT 0,
  ALTER COLUMN group_invite_base_monthly SET DEFAULT 0,
  ALTER COLUMN rag_base_chunks           SET DEFAULT 0;
