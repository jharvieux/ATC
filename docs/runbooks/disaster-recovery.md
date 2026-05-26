# Disaster recovery runbook (§29.14)

Operator-facing recovery procedures for the AI Travel Concierge platform.
Single-region single-cloud posture is acceptable risk at launch volume per
§29.14; multi-region is explicitly out of v6 scope.

This runbook is the **first place to look** when a production failure
exceeds the bounds of a simple deploy rollback.

---

## How to use this runbook

1. **Identify the scenario** in the table below — match symptoms to a
   row.
2. **Follow the linked procedure** verbatim. Do not improvise during an
   incident — that is what the post-incident review is for.
3. **Open an incident channel** before running any destructive
   recovery (PITR restore, full-DB restore). Two-person rule applies.
4. **Update the active incident record** with timestamps + actions
   taken as you go.

---

## Scenario decision matrix

| Scenario | RTO target | RPO target | Procedure |
|---|---|---|---|
| Bad deploy | < 5 min | 0 | [Vercel instant rollback](#vercel-instant-rollback) |
| Single bad migration | ~30 min | 0 | [Forward-fix hotfix](#forward-fix-hotfix-migration) |
| Tenant-level data corruption | ~1 hr | depends on audit_log coverage | [Targeted SQL repair](#targeted-sql-repair) |
| Production DB partial corruption | < 2 hr | minutes (PITR) | [Point-in-time recovery](#point-in-time-recovery) |
| Production DB total loss | < 4 hr | up to 24 h | [Restore from daily backup](#restore-from-daily-backup) |
| Vercel platform outage | — | — | [No mitigation (single-cloud)](#vercel-outage) |
| Supabase platform outage | — | — | [No mitigation (single-vendor)](#supabase-outage) |
| Anthropic outage | < 1 min | 0 | [AI kill switch activates](#anthropic-outage) |
| US-East region outage | undefined | undefined | [No automated failover in v6](#us-east-region-outage) |

The "no mitigation" rows are intentional per §29.14. They become
prerequisites for revisit when (a) a tenant SLA contract demands it, or
(b) two material outages happen in a 12-month window.

---

## Vercel instant rollback

**Scenario:** A deploy broke production. The previous deploy was known
good.

1. Open the Vercel dashboard for `atc-main` and `atc-rag` (separate
   projects per MEMORY D-029).
2. In each project, go to **Deployments** → find the last known-good
   deploy (typically the one immediately before the broken one).
3. Click the **⋯** menu → **Promote to Production**.
4. Verify in two windows:
   - Hit the production URL; confirm the version banner or a known UI
     element renders the previous code.
   - Tail Sentry for new error rate — should drop within 60 seconds of
     promotion.
5. **Post-rollback:** create a postmortem ticket with the original
   broken commit SHA + the symptom that triggered the rollback. The fix
   forward happens on a feature branch with tests.

**RTO:** < 5 minutes from "we should roll back" to "production stable".

See also: `docs/runbooks/rollback-application.md` for the longer form.

---

## Forward-fix hotfix migration

**Scenario:** A migration shipped to production that has a bug —
incorrect column type, missing default, broken constraint, etc.

Database migrations are **forward-only**. We never run a `DROP`-style
reverse migration on production (D-040). The fix is always a new
migration.

1. Create a hotfix branch off `main` (NOT `dev`): `hotfix/<short-name>`.
2. Write a new migration file with the next timestamp (e.g.
   `20260526000000_fix_<short-name>.sql`) that:
   - Reverses or compensates the bad change with `ALTER` /`UPDATE`
     statements.
   - Includes an explicit `BEGIN ... COMMIT` if the fix spans multiple
     statements.
3. Run the hotfix migration against staging first (`pnpm db:migrate` in
   the staging env). Verify behavior.
4. Open a PR labelled `hotfix` directly into `main`. CI runs; merge.
5. The release pipeline auto-deploys `main` to production. The new
   migration runs as part of deploy.
6. **Post-fix:** open a follow-up PR to `dev` cherry-picking the hotfix
   so the next normal release doesn't reintroduce the issue.

**RTO:** ~30 minutes including verification.

See also: `docs/runbooks/rollback-database.md` for the case where the
data itself needs unwinding (different procedure).

---

## Targeted SQL repair

**Scenario:** A specific tenant's data is wrong (e.g., a stuck
`commission` row, an orphan booking, a corrupted JSONB column on a
single record). Other tenants are unaffected.

1. **Capture before-state.** Run a `SELECT` against the affected row(s)
   and save the output to the incident ticket.
2. **Check audit_log** for any context: the corruption may be visible as
   a recent unexpected write. `SELECT * FROM audit_log WHERE
   resource_id = '<id>' ORDER BY created_at DESC LIMIT 50`.
3. **Two-person review.** Write the repair SQL — typically a single
   `UPDATE` or `DELETE` — and have a second engineer review against the
   before-state.
4. **Run in a transaction** with explicit `BEGIN` so you can `ROLLBACK`
   if the result count is wrong:
   ```sql
   BEGIN;
   UPDATE foo SET bar = 'baz' WHERE id = 'xxxxx';
   -- VERIFY: SELECT * FROM foo WHERE id = 'xxxxx';
   COMMIT;  -- or ROLLBACK if it doesn't look right
   ```
5. **Write a repair audit_log row** so the operation is traceable:
   ```sql
   INSERT INTO audit_log (actor_type, action, resource_type,
     resource_id, changes)
   VALUES ('admin', 'data_repair', 'foo', 'xxxxx',
     '{"reason": "stuck-row-from-incident-INC-NNN",
       "before": {...}, "after": {...}}');
   ```

**RTO:** ~1 hour including review.

---

## Point-in-time recovery

**Scenario:** Production database has partial corruption that spans
multiple rows / tables, OR a destructive change went out that needs to
be undone. Supabase Pro tier provides 7-day PITR.

1. **Open incident channel.** Two-person rule applies — destructive
   restore is not a solo operation.
2. **Identify the recovery target time.** Inspect `audit_log` to find
   the timestamp of the last known-good state. Round DOWN to a safe
   margin (e.g., if the bad change happened at 14:23, restore to 14:00).
3. **Decide restore strategy:**
   - **In-place restore** — overwrites the production database. Use ONLY
     when the entire database is unrecoverable. **All writes since the
     recovery point are LOST.**
   - **Side-restore** — Supabase clones the database into a new project
     at the target time. Use this when you need to extract specific rows
     from the past state and merge into live production. **Default for
     most incidents.**
4. **Initiate via Supabase dashboard:**
   - Settings → Database → Point-in-Time Recovery
   - Pick the recovery timestamp
   - For side-restore: a new project URL is provisioned in ~30-45 min
5. **Reconcile.** If side-restoring, write a script (`scripts/incident-INC-NNN-reconcile.ts`)
   that compares the affected rows in old-state vs live-state and
   surgically merges. Two-person review.
6. **Audit_log entries** for every reconciliation operation per the
   targeted-SQL-repair procedure above.

**RTO:** ~2 hours.  
**RPO:** From the recovery timestamp forward, all writes are lost (in-place)
or must be manually reconciled (side-restore).

---

## Restore from daily backup

**Scenario:** Production database total loss. The PITR window
(7 days) is somehow also unavailable. Worst-case recovery.

Supabase takes a daily backup at 00:00 UTC (Pro tier and above; verify
the schedule in the project settings).

1. **Verify backup availability.** Supabase dashboard → Settings →
   Database → Backups. Confirm the most recent backup timestamp.
2. **Provision a new Supabase project** if the original is gone (atc-main
   replacement). Document the new project ref.
3. **Restore via the Supabase support channel.** Open a P1 ticket with
   Supabase support including:
   - Original project ref
   - Target backup timestamp
   - New project ref to restore into
4. **Update Vercel env vars** to point at the new project:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - Repeat for both `atc-main` and `atc-rag` if both DBs are affected.
5. **Restart application** so new env vars take effect.
6. **Run a smoke-check script** that verifies tenants are accessible,
   bookings load, RAG retrieval works.
7. **Communicate** the data-loss window (typically up to 24h) to
   affected tenants per the §26.10 breach-response procedure.

**RTO:** < 4 hours.  
**RPO:** Up to 24 hours of data loss.

---

## Vercel outage

**Scenario:** Vercel platform itself is degraded or down.

There is NO mitigation in v6. Single-cloud dependency is documented and
accepted.

1. **Communicate via the public status page** (separate hosting, NOT
   on Vercel — confirm the status page is not co-hosted).
2. **Monitor Vercel's own status page** for ETA.
3. **Do not attempt to fail over** to a different host — there is no
   warm standby. Any failover attempt during an incident would extend
   the outage.

**Revisit trigger:** Two material Vercel outages in a 12-month window
or a tenant SLA contract requiring a regional / multi-cloud posture.

---

## Supabase outage

**Scenario:** Supabase platform itself is degraded or down.

Same posture as the Vercel outage. No mitigation in v6.

The chat surface will show the AI-unavailable fallback because Supabase
RLS queries will fail. The §10.6 AI kill switch is independent of
Supabase and won't help here — the kill switch is itself stored in
`platform_settings`, which lives in Supabase.

1. **Status-page communication only.**
2. **Monitor Supabase status page** for ETA.

---

## Anthropic outage

**Scenario:** Anthropic Claude API is degraded or down. The chat
surface cannot produce AI responses.

1. **AI kill switch activates automatically** via the vendor-health
   monitor (`inngest/vendor-health-check`). Within 60 seconds of
   sustained failures, `platform_settings.ai_kill_switch_engaged = true`
   is written.
2. **Customer chat surface** detects this and renders the §10.6
   fallback message:  
   > "Our AI is taking a brief break. A human will be in touch shortly."
3. **In-flight requests** receive the same fallback as their final
   response.
4. **Queue resumes** when the vendor-health monitor sees Anthropic
   returning successful responses again.

**Operator action:** none required during the outage. After resolution,
confirm the kill switch reset and that the next-scheduled supervisor
sampling run executes (catches any drift introduced by the outage).

See also: §26.9 vendor outage handling.

---

## US-East region outage

**Scenario:** AWS us-east-1 (where Supabase and Vercel default region
are hosted) experiences a regional outage.

**RPO and RTO are undefined** for this scenario per §29.14.

There is no automated failover in v6. Manual recovery would require:
1. Identifying a target region that has working Vercel + Supabase
   capacity.
2. Provisioning new infrastructure there.
3. Restoring from the most recent daily backup.

This is effectively a "rebuild from backup" scenario taking ~24+ hours.

**Revisit trigger:** Same as Vercel/Supabase outages — two materials
events in a 12-month window or a tenant SLA contract.

---

## Backup verification cadence

Once per month:

1. Pick a recent daily backup at random.
2. Restore into a new Supabase project (a "fire drill" project).
3. Run the smoke-check script against it.
4. Verify the smoke check succeeds.
5. Tear down the fire-drill project.
6. Record the date in a backup-verification log
   (`docs/runbooks/_backup-verification-log.md`).

This is the only way to know backups actually work. **A backup that has
never been restored is not a backup.**

---

## Recovery rehearsal log

The platform is required (per SOC 2 readiness goal in §26.12) to
demonstrate that the recovery procedures have been **rehearsed**, not
just documented.

Quarterly:

1. Pick one of the procedures above (rotate through them year over
   year).
2. Run a tabletop exercise: walk through it in a 60-min meeting,
   identify gaps or out-of-date steps.
3. Update this runbook with any corrections.
4. Log the rehearsal date + the procedure exercised in a separate log
   (`docs/runbooks/_recovery-rehearsal-log.md`).

This is a SOC 2 prerequisite. The auditor will ask for the log.

---

## Cross-references

- `docs/runbooks/rollback-application.md` — Vercel deploy rollback (long form)
- `docs/runbooks/rollback-database.md` — DB-state unwinding
- `docs/runbooks/breach-response.md` — §26.10 breach communication procedure
- `docs/runbooks/secret-rotation.md` — Required when credentials are
  compromised (often a sub-step of incident response)
- §10.6 (AI kill switch), §15.16 (payment past-grace), §26.10
  (breach-response), §29.14 (DR posture statement)
