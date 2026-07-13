-- Migration: reserve_group_invitations_atomic
-- Version:   20260722000022
-- Generated: 2026-07-13T12:10:54Z by scripts/new-migration.sh
-- Branch:    feature/sweep-groups-toctou-1680
-- Worktree:  agent-ad92e6a13a55204eb
--
-- #1680 / #1875 — atomic enforcement of the 50-active-invitee-per-group cap.
--
-- Before this, two routes enforced the cap with a SELECT-count-then-INSERT that
-- is not atomic under PostgREST's autocommit-per-call model:
--   * POST /api/groups/[id]/invitations (single invite) — #1680: two concurrent
--     invites to the same group could both read count=49, both pass the < 50
--     check, and both insert → 51 active. A one-statement
--     INSERT ... WHERE (SELECT count(*)) < cap does NOT fix this under READ
--     COMMITTED (both count subqueries read the pre-commit snapshot), it only
--     narrows the window.
--   * POST /api/groups/[id]/members (batch invite) — #1875: had NO cumulative
--     cap check at all. The only bound was the per-request Zod .max(50), so a
--     coordinator could call it repeatedly (or once when the group already had
--     invitees) and push the group well past 50 — a straight bypass, no race.
--
-- Fix: one SECURITY DEFINER function that takes a transaction-scoped advisory
-- lock keyed on the group id, re-counts the active invitees, rejects when
-- active + incoming would exceed the cap, and inserts the whole batch — all in
-- one transaction. Same-group reservations serialize on the lock; different
-- groups never contend. Both routes call it via .rpc(); the single-invite route
-- passes a 1-element array, the members route passes the whole batch. The cap
-- is a parameter so MAX_INVITEES_PER_GROUP (apps/main/src/lib/groups/constants.ts)
-- stays the single canonical source in TS. On the boundary, active + incoming
-- <= cap is allowed (49 active + 1 = 50 OK; 50 active + 1 = 51 rejected),
-- matching the pre-existing single-invite boundary.
--
-- Returns jsonb: {"status":"ok","inserted":N} on success, or
-- {"status":"cap_exceeded","active_count":M} when the reservation is refused
-- (nothing inserted). A duplicate active (group, lower(email)) still raises
-- unique_violation (23505) from invitations_group_active_email_uniq_idx, which
-- PostgREST surfaces as error.code '23505' — the single-invite route maps that
-- to 409 invitee_already_invited exactly as before.
--
-- Security: SECURITY DEFINER with an empty search_path (every user object is
-- schema-qualified; built-ins resolve from pg_catalog) so the service-role
-- caller writes under the definer role; EXECUTE revoked from PUBLIC/anon/
-- authenticated and granted only to service_role. Callers are on the
-- no-direct-service-role-import allowlist. No policy is created and function
-- EXECUTE grants are not captured by db/grants-snapshot-main.sql (table/sequence
-- grants only), so no snapshot regen is required.

create or replace function public.reserve_group_invitations(
  p_group_id    uuid,
  p_invitations jsonb,
  p_max         integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incoming integer := coalesce(jsonb_array_length(p_invitations), 0);
  v_active   integer;
begin
  if v_incoming = 0 then
    return jsonb_build_object('status', 'ok', 'inserted', 0);
  end if;

  -- Serialize concurrent reservations for the SAME group so the count-check and
  -- insert are one atomic unit (closes the #1680 TOCTOU). int8 cast matches the
  -- single-key pg_advisory_xact_lock overload (see admin_change_platform_role).
  perform pg_advisory_xact_lock(hashtext(p_group_id::text)::int8);

  select count(*) into v_active
  from public.invitations
  where group_id = p_group_id
    and token_revoked_at is null;

  if v_active + v_incoming > p_max then
    return jsonb_build_object('status', 'cap_exceeded', 'active_count', v_active);
  end if;

  insert into public.invitations
    (id, group_id, invitee_email, invitee_name, personal_note, visibility_choice, token)
  select
    (r->>'id')::uuid,
    p_group_id,
    r->>'invitee_email',
    r->>'invitee_name',
    r->>'personal_note',
    coalesce(r->>'visibility_choice', 'no_opinion'),
    r->>'token'
  from jsonb_array_elements(p_invitations) as r;

  return jsonb_build_object('status', 'ok', 'inserted', v_incoming);
end;
$$;

revoke execute on function public.reserve_group_invitations(uuid, jsonb, integer) from public;
revoke execute on function public.reserve_group_invitations(uuid, jsonb, integer) from anon, authenticated;
grant execute on function public.reserve_group_invitations(uuid, jsonb, integer) to service_role;

comment on function public.reserve_group_invitations(uuid, jsonb, integer) is
  '#1680/#1875: advisory-lock-serialized atomic reserve+insert for the per-group active-invitee cap. Returns {status:ok,inserted} or {status:cap_exceeded,active_count}. service_role-only.';
