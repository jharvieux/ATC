-- Migration: help_sessions_purge_orphans
-- Version:   20260814155007
-- Generated: 2026-08-14T15:50:07Z by scripts/new-migration.sh
-- Branch:    feature/sweep-retention-2037
-- Worktree:  atc-sweep-retention-2037
--
-- #2037 — delete aged help sessions only when neither retained submission table
-- references them. The retention worker cannot safely express this invariant via
-- a broad table DELETE grant: service_role bypasses RLS. This SECURITY DEFINER
-- RPC keeps the predicates and the 1,000-row bound at the privilege boundary.
--
-- SECURITY DEFINER uses an empty search_path and every user object is qualified,
-- preventing caller-controlled object shadowing. Only service_role can execute;
-- its direct DELETE privilege on public.help_sessions remains revoked. Function
-- EXECUTE grants are not included in the table/sequence grants snapshot, so no
-- snapshot regeneration is required.

create or replace function public.purge_orphaned_help_sessions(
  p_cutoff timestamptz,
  p_limit integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_cutoff is null then
    raise exception 'p_cutoff is required';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'p_limit must be between 1 and 1000';
  end if;

  with candidates as (
    select hs.id
    from public.help_sessions as hs
    where hs.started_at < p_cutoff
      and not exists (
        select 1
        from public.bug_submissions as bs
        where bs.help_session_id = hs.id
      )
      and not exists (
        select 1
        from public.feature_requests as fr
        where fr.help_session_id = hs.id
      )
    order by hs.started_at, hs.id
    limit p_limit
  ), deleted as (
    delete from public.help_sessions as hs
    using candidates
    where hs.id = candidates.id
      and hs.started_at < p_cutoff
      and not exists (
        select 1
        from public.bug_submissions as bs
        where bs.help_session_id = hs.id
      )
      and not exists (
        select 1
        from public.feature_requests as fr
        where fr.help_session_id = hs.id
      )
    returning hs.id
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

revoke execute on function public.purge_orphaned_help_sessions(timestamptz, integer) from public;
revoke execute on function public.purge_orphaned_help_sessions(timestamptz, integer) from anon, authenticated;
grant execute on function public.purge_orphaned_help_sessions(timestamptz, integer) to service_role;

comment on function public.purge_orphaned_help_sessions(timestamptz, integer) is
  '#2037: bounded aged-orphan help-session purge. SECURITY DEFINER enforces no bug or feature submission children; service_role-only.';
