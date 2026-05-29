# Session state — last updated 2026-05-29 ~05:00 UTC

## Just completed
- **Retroactive D-091 anti-pattern sweep — COMPLETE (all 3 waves filed).** Ran parallel `d091-reviewer` passes partitioned by domain, hand-verified every finding against live code @ `dev ae4c727`, filed grouped by anti-pattern (not by file). Nothing auto-fixed — the issues are the deliverable for the user to route.
  - **Pattern issues (label `d091-audit`):** #392 [P1] void-async, #393 [P2] fail-open/swallowed-read (incl. the Wave 3 Inngest-cron error-swallow sub-cluster), #394 [P2] CAS missing row-count, #395 [P2] single-layer isolation, #396 [P2] GCV key in URL, #397 [P2] non-constant-time bearer, #399 [P1] supervisor kill-switch fail-open, #400 [P2] unchecked mutation, #401 [P2] stub-shaped. Master index/epic: **#398**.
  - **Wave 2** (commerce, admin/supervisor, tenant/CRM, AI/persona) → NEW #399/#400/#401 + appends to #392–#395.
  - **Wave 3** (help/imports/public, Inngest serve+client, all 78 Inngest jobs) → **no new pattern issues**; all sites appended as comments onto #392/#393/#394/#400/#401; epic #398 body updated with the Wave 3 section.
  - **Severity honesty:** agents over-rated (~9 phantom "P1/BLOCKER" in Wave 3 → none survived hand-verify as clean P1, all re-rated P2). 3 false positives caught + documented-rejected (user/privacy ternary; help close/escalate — `help_sessions` is tenant-scoped; `admin-fetch.ts` client wrapper).
- MEMORY.md decision-log entry **D-114** added (audit method + severity-honesty outcome + the one open question).

## In flight
- **EOS checkpoint PR** for the two repo doc changes (MEMORY.md D-114 + this SESSION.md). Branch + PR being opened now; no code changed this session. If interrupted before merge: the branch holds both files; finish the PR into `dev` with the mandatory `## Audit` block, wait for CI, squash-merge, delete branch.

## Next step
- Finish the EOS checkpoint PR (CI green → squash-merge → delete branch).

## Blocked on user
- **#394 / `apps/main/src/inngest/tenant-on-terminated.ts:51` — P1-candidate needs a PRODUCT answer, not code review:** the CAS `.eq("status","suspended")` has no row-count assert, so on a zero-row match the irreversible `onTerminated()` (unbinds custom domain, deletes OAuth creds) still runs. **Does the un-suspend flow cancel the scheduled `tenant.termination_scheduled` event?** If yes → P2; if no → real P1 (can nuke an active paying tenant). User to confirm.
- **Triage routing of all 9 `d091-audit` issues** — these are the deliverable; none auto-fixed. User decides which to fix and in what order.
- Operator follow-ups from D-112 (re-point `supabase-main` MCP to mfaknjyqiwcjojukcnea; prod redeploy). Issue #386 (dedicated test Supabase project). Counsel sign-off (P4 #37-#43), operator decisions (P4 #48-#55) — unchanged.

## Open questions
- Issue granularity = one per anti-pattern (grouped across sites), not one per site. Revisit if the user wants finer tracking.
- #384 Class-A test reimplementations, dependabot PR state — unchanged from prior session, not touched.

## Reminder
- Session is on **Opus** — run `/model claude-sonnet-4-6` to switch back (the agent cannot self-invoke `/model`).

## Carried forward (unchanged)
- BP39 react-pdf wire-up; BP31 Haiku PII scorer (P3 #32); BP30 eval harness (P3 #35); BP25 PLATFORM_PEPPER offsite (P4 #46); BP24 supervisor_slur_deny_list (P4 #45); BP23 port_info_chunks (P4 #44); BP16/17 counsel sign-off (P4 #41); §13.9 health probing (P4 #48); Booking Stages 2/3; persona-addendum-rescreen flush window.
