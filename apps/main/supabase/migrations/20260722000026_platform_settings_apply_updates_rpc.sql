-- Migration: platform_settings_apply_updates_rpc
-- Version:   20260722000026
-- Generated: 2026-07-16T20:25:15Z by scripts/new-migration.sh
-- Branch:    feature/sweep-admin-1936
-- Worktree:  agent-a3ee70f171831d10f
--
-- #1936 (D-091 #22 collectively-atomic multi-writes) — atomic multi-key apply
-- for the admin retrieval-weights / feedback-settings PUT routes.
--
-- Before this, each per-key platform_settings UPDATE ran as its own autocommit
-- (withPlatformAdminAudit hands the callback a plain service-role client, no
-- transaction). On a mixed PUT where one key applied and another matched no
-- row, the applied key committed durably in main, the route threw a 500 and
-- (correctly) published no RAG-sync event — leaving main and the rag replica
-- diverged until the nightly platform-settings-reconcile cron closed the gap
-- (up to 24h), with the admin unaware their change had partially taken effect.
--
-- This function applies every {key, value} change in a SINGLE plpgsql
-- invocation — one implicit transaction. Any key that matches no row RAISEs,
-- which aborts and rolls back the whole call, so a partial PUT leaves NO key
-- applied. It returns the post-write updated_at per key so the route can derive
-- source_revision exactly as the per-key path did (the platform_settings
-- BEFORE UPDATE trigger set_platform_settings_updated_at bumps updated_at).
--
-- SECURITY DEFINER + empty search_path (every object schema-qualified) so the
-- service-role caller runs the writes; EXECUTE revoked from PUBLIC and granted
-- only to service_role. Function EXECUTE grants are not captured by the
-- table-DML grants snapshot (scripts/grants-snapshot.ts, relkind='r' only), so
-- no snapshot regen accompanies this migration.

CREATE OR REPLACE FUNCTION public.platform_settings_apply_updates(p_changes JSONB)
RETURNS TABLE (setting_key TEXT, setting_updated_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_change JSONB;
  v_key    TEXT;
BEGIN
  IF p_changes IS NULL
     OR jsonb_typeof(p_changes) <> 'array'
     OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'platform_settings_apply_updates: p_changes must be a non-empty JSONB array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_change IN SELECT elem FROM jsonb_array_elements(p_changes) AS elem
  LOOP
    v_key := v_change ->> 'key';
    IF v_key IS NULL OR (v_change -> 'value') IS NULL THEN
      RAISE EXCEPTION 'platform_settings_apply_updates: each change requires a key and a value'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    UPDATE public.platform_settings AS ps
      SET value = v_change -> 'value'
      WHERE ps.key = v_key
      RETURNING ps.key, ps.updated_at INTO setting_key, setting_updated_at;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'platform_settings key % matched no row', v_key
        USING ERRCODE = 'no_data_found';
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.platform_settings_apply_updates(JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.platform_settings_apply_updates(JSONB) TO service_role;

COMMENT ON FUNCTION public.platform_settings_apply_updates(JSONB) IS
  '#1936: atomically apply a JSONB array of {key,value} platform_settings changes in one transaction; RAISE (rolling back all) if any key matches no row. Returns per-key updated_at. SECURITY DEFINER, service_role only.';
