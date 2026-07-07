-- #1581 — CAS row claim for task-reminders-fire to prevent double-send on
-- overlapping cron runs. `sending_at` is a claim timestamp distinct from
-- `fired_at` (the final settle time): a row is claimed by stamping
-- `sending_at`, then finalized by stamping `fired_at`/`fired_status` and
-- clearing `sending_at`. A row whose claim goes stale (crashed run) is
-- auto-reclaimed once `sending_at` is older than the cron's timeout guard.
ALTER TABLE public.task_reminders ADD COLUMN IF NOT EXISTS sending_at TIMESTAMPTZ;
