-- Resolve an auth user's id by email, for platform-admin management.
--
-- The superadmin-gated /api/admin/admins route turns an operator-entered email
-- into an auth.users.id to insert into platform_admins. auth.users is not exposed
-- via PostgREST, so this SECURITY DEFINER function does the lookup.
--
-- Locked down: EXECUTE is revoked from PUBLIC/anon/authenticated and granted only
-- to service_role (the gated API runs as the service role). That prevents it from
-- being used as an email-enumeration oracle by ordinary sessions. STABLE +
-- empty search_path + fully-qualified auth.users guards against search-path tricks.

create or replace function public.admin_lookup_auth_user_by_email(p_email text)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

revoke all on function public.admin_lookup_auth_user_by_email(text) from public;
revoke all on function public.admin_lookup_auth_user_by_email(text) from anon, authenticated;
grant execute on function public.admin_lookup_auth_user_by_email(text) to service_role;
