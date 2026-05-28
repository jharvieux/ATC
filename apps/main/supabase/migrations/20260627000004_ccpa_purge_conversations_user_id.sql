-- Greptile audit-followups P2 #13 — record the conversations.user_id
-- nulled count on each CCPA purge execution so the audit row matches the
-- code path. Without this column, the new counter in purge-user-data.ts
-- would be silently dropped from the insert (extra fields are ignored by
-- PostgREST and we'd lose the audit trail for this category-1 sub-step).

ALTER TABLE public.ccpa_deletion_executions
  ADD COLUMN IF NOT EXISTS category_1_conversations_user_id_nulled_count
    INTEGER NOT NULL DEFAULT 0;
