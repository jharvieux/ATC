-- #813 — Atomic last-superadmin guard for platform-admin role change / removal.
--
-- The app-level guard (count superadmins, then UPDATE/DELETE in a separate
-- statement) had a TOCTOU: two concurrent demotions could each observe count=2
-- and both commit, leaving zero superadmins. These SECURITY DEFINER functions
-- take a transaction-scoped advisory lock so ALL platform-admin mutations
-- serialize, then re-check the superadmin count and mutate atomically. They
-- return a status string the route maps to HTTP. service_role-only (the
-- superadmin-gated route runs as service-role).

create or replace function public.admin_change_platform_role(p_target uuid, p_new_role text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
  v_superadmins int;
begin
  perform pg_advisory_xact_lock(hashtext('platform_admins_management')::int8);
  select role into v_current from public.platform_admins where auth_user_id = p_target;
  if v_current is null then
    return 'not_found';
  end if;
  if v_current = 'superadmin' and p_new_role <> 'superadmin' then
    select count(*) into v_superadmins from public.platform_admins where role = 'superadmin';
    if v_superadmins <= 1 then
      return 'last_superadmin';
    end if;
  end if;
  update public.platform_admins set role = p_new_role where auth_user_id = p_target;
  return 'ok';
end;
$$;

revoke execute on function public.admin_change_platform_role(uuid, text) from public;
revoke execute on function public.admin_change_platform_role(uuid, text) from anon, authenticated;
grant execute on function public.admin_change_platform_role(uuid, text) to service_role;

create or replace function public.admin_remove_platform_admin(p_target uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current text;
  v_superadmins int;
begin
  perform pg_advisory_xact_lock(hashtext('platform_admins_management')::int8);
  select role into v_current from public.platform_admins where auth_user_id = p_target;
  if v_current is null then
    return 'not_found';
  end if;
  if v_current = 'superadmin' then
    select count(*) into v_superadmins from public.platform_admins where role = 'superadmin';
    if v_superadmins <= 1 then
      return 'last_superadmin';
    end if;
  end if;
  delete from public.platform_admins where auth_user_id = p_target;
  return 'ok';
end;
$$;

revoke execute on function public.admin_remove_platform_admin(uuid) from public;
revoke execute on function public.admin_remove_platform_admin(uuid) from anon, authenticated;
grant execute on function public.admin_remove_platform_admin(uuid) to service_role;
