-- Security advisor (function_search_path_mutable) — pin search_path.
--
-- These six functions were created without a fixed search_path. All six
-- have fully schema-qualified bodies (or use only pg_catalog builtins such
-- as now()), so pinning search_path to '' is behavior-preserving. Applied
-- via ALTER FUNCTION rather than CREATE OR REPLACE to avoid re-stating the
-- bodies (and the attendant risk of transcription drift).
--
-- Two further items from the same advisor are handled outside this file:
--   - extension_in_public (rag): moving the `vector` extension out of public
--     has real blast radius (every vector column/index/type reference) and
--     needs a rehearsed migration -- deferred, see PR notes.
--   - auth_leaked_password_protection (main): a Supabase Auth dashboard
--     toggle, not a migration -- see PR notes.

ALTER FUNCTION public.set_updated_at()                            SET search_path = '';
ALTER FUNCTION public.set_platform_settings_updated_at()          SET search_path = '';
ALTER FUNCTION public.set_import_queue_updated_at()               SET search_path = '';
ALTER FUNCTION public.attribution_touches_trim_to_ten()           SET search_path = '';
ALTER FUNCTION public.seed_attribution_categories_for_tenant(UUID) SET search_path = '';
ALTER FUNCTION public.seed_default_task_sequences_for_tenant(UUID) SET search_path = '';
