-- #903 follow-up — DML grants for the voice-profile tables.
--
-- The 20260629000001 migration created voice_samples + voice_profiles with
-- RLS policies but NO table-level grants, so authenticated users were denied
-- at the privilege layer before RLS ever evaluated (grants-snapshot diff
-- caught it). Grants mirror the RLS surface, following the rag_submissions
-- convention: authenticated gets only the verbs its policies permit
-- (DELETE stays service-role-only on both tables; voice_samples UPDATE is
-- RLS-false so it isn't granted either); service_role gets full DML.

GRANT INSERT, SELECT ON public.voice_samples TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.voice_samples TO service_role;

GRANT INSERT, SELECT, UPDATE ON public.voice_profiles TO authenticated;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.voice_profiles TO service_role;
