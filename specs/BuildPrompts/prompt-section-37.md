# Build Prompt — Section 37: Tasks & Follow-up

## MODEL: Claude Opus

**Before starting this build, switch to Claude Opus.** This build involves Inngest delayed-event sequence orchestration spanning months, a single-table-with-four-FK constraint pattern, snapshot-on-trigger logic to make sequence editing safe, and cross-cutting integrations (system events, AI suggestions, calendar hooks). Opus's reasoning depth is needed. Do not start with Sonnet, Haiku, or any non-Opus model.

---

## What you're building

A tasks surface — ad-hoc agent tasks, sequenced cadences, system-generated tasks, and AI-suggested tasks — attached to contacts/quotes/bookings/conversations with reminders, assignment, and completion tracking.

## Primary spec reference

`section-37-addendum-tasks-and-follow-up.html` — full specification including schemas, sequence orchestration, default sequences shipped to new tenants, and tier gating.

## Cross-references — read before starting

- `section-05-database-schema-main-app.html` — base patterns for tenant_id, RLS, audit
- `section-09-ai-personas.html` — `ai_mode` flag that gates AI suggestions (§9.10)
- `section-10-ai-supervisor.html` — supervisor patterns for AI-suggested-task pre-flight
- `section-11-customer-memory.html` — memory extraction may produce task suggestions (§11.2)
- `section-12-crm.html` — pipeline stage transitions that emit trigger events
- `section-14-commissions-splits-payouts.html` — final payment due dates that trigger system tasks
- `section-20-booking-flow.html` — booking events that trigger sequences
- `section-23-email-notifications.html` — email reminder channel, rate limits (§23.3)
- `section-26-security.html` — audit_log for task changes
- `section-34-addendum-inbound-import.html#s34-7-3` — system task for commission rate missing on imported booking

## Build order

1. **Schema** — Per §37.2: `tasks` table with the exactly-one-of-four FK CHECK. Per §37.3: `task_reminders`. Per §37.4.1: `task_sequences`, `task_sequence_steps`, `task_sequence_runs` (with the exactly-one-of-three FK CHECK). RLS on all per §5.1.
2. **Reminder firing job** — Inngest scheduled function every minute, processes rows with `remind_at <= NOW() AND fired_at IS NULL`. Mark `fired_at` + `fired_status` after dispatch. Retain rows for audit.
3. **In-app reminder delivery** — Notification badge in CRM nav; notifications panel; read/unread tracking.
4. **Email reminder delivery** — React Email template per §23; respect rate limits and suppression list.
5. **Snooze handler** — Sets `status='snoozed'` + `snoozed_until`; suppresses prior reminders; auto-restores to `open` at expiry.
6. **Trigger event emission** — Pipeline status transitions in §12 emit events: `lead_created`, `quote_sent`, `quote_accepted`, `booking_created`, `booking_confirmed`, `pre_sail_60d`, `post_sail_7d`. **CRITICAL: Verify §12 implementation actually emits these — cross-build coordination required.**
7. **Sequence triggering** — On trigger event, look up active sequences matching, create `task_sequence_runs` row, dispatch delayed Inngest events for each step.
8. **Step snapshot at run-start** — Per §37.8.1: copy current `task_sequence_steps` definitions into the run (JSONB on run row OR a snapshot table — pick at build time). Delayed events use the snapshot, not live definition.
9. **skip_if_status check** — At task-creation time (post-snapshot read of live record), check current status against `skip_if_status` array; skip step if matched.
10. **Sequence cancellation** — Terminal record states OR agent cancel OR sequence deactivation. Cancel all future Inngest delayed events for the run.
11. **Template substitution** — Simple string-replace for `{{contact.first_name}}` etc. Missing variables → empty string. NO Jinja/Handlebars runtime.
12. **Default sequences seeding** — At new tenant creation, seed the 4 sequences listed in §37.4.5. Active by default; tenant can disable/modify.
13. **System-generated tasks** — Daily Inngest scheduled function that scans for the conditions in §37.5 (passport expiring, final payment due, quote about to expire, etc.) and creates tasks with `origin='system'`. Use UNIQUE on (tenant_id, origin, origin_reference) to prevent duplicates.
14. **AI-suggested tasks** — Hook into chat supervisor (§10) and memory extraction (§11.2). Tasks land with `origin='ai_suggested'` and a clear UI marker. Gated by `ai_mode != 'disabled'`. Dismissed suggestions logged.
15. **Task UI** — "My Tasks" dashboard (default), "All Tasks" (Agency-tier only), per-record task lists on contact/quote/booking detail pages. Quick-add controls. Mobile-responsive — high mobile-usage feature.
16. **Sequence management UI** — Per §37.8: list/create/edit/deactivate; active runs view.
17. **Tier gating** — Per §37.10 matrix. Sequences for all paid tiers; assignment + cross-user view for Agency tiers; custom sequence creation Agency only.

## Required tests

- Task FK CHECK enforces exactly-one-of-four
- Sequence FK CHECK enforces exactly-one-of-three
- Reminder firing job processes rows in order of `remind_at`; no duplicate fires
- Snoozed task: reminders before `snoozed_until` suppressed; reminders at-or-after fire; status auto-restores
- Sequence triggered on `quote_sent` event creates run + dispatches delayed events for all steps
- Sequence step snapshot at run-start: editing sequence definition AFTER run starts does NOT affect that run's remaining steps
- `skip_if_status` skips step at task-creation time, not at scheduling time (post-snapshot live record read)
- Quote accepted DURING a "post-quote nurture" run → run cancelled, all future Inngest delayed events cancelled, existing tasks remain
- System task duplicate prevention: passport-check job creating same task twice rejected by UNIQUE constraint
- Template substitution: `{{contact.first_name}}` populated; `{{quote.cruise_line}}` on a contact-scoped sequence renders empty
- AI-suggested task with `ai_mode='disabled'` does NOT appear
- Agency-tier task assignment to another user: receiving user sees in their "My Tasks"
- BYO Research: ad-hoc tasks work; sequences do NOT (UI gates)
- Default sequences appear in new tenant's settings; can be disabled
- Email reminder respects suppression list; sets `fired_status='suppressed'`
- Mobile-responsive view: today's tasks viewable, mark-complete and snooze functional
- Audit log: every task creation/edit/completion logged per §26.5

## Hand-off to other sections

- §12 pipeline transitions MUST emit the trigger events listed in §37.4.1. Verify at integration test time.
- §10 supervisor and §11 memory extraction MUST be able to call task-suggestion API.
- §34 import flow's "imported booking pending commission rate input" condition MUST trigger the corresponding system task.

## Open items deferred at build time

- Calendar integration (iCal feed, Google Calendar sync) per §37.9 — schema ready, no implementation in v1
- Tenant-customizable trigger word for IMPORT (mentioned in §34, not §37 directly)
- Inngest delay maximum verification at build time (should be >1yr; confirm)

---

## When you finish

**Switch model back to your default.** Confirm to the user that the build is complete with: schema applied, reminder firing job live, sequences triggering on pipeline events, step snapshot working, system tasks generated daily without duplicates, AI suggestions gated by `ai_mode`, default sequences seeded for new tenants, mobile UX functional. Note cross-build coordination items resolved.
