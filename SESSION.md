# Session state — last updated 2026-05-25 ~14:00 UTC

## Just completed (this push)

### Security audits — 2026-05-25

Ran three parallel Agent audits over the BP34–BP40 codebase (auth boundary, tenant isolation, Stripe/payments) plus a fourth on the RAG service. Documented findings and fixed every HIGH-confidence one.

### Security PRs landed on `dev`

| PR | What |
|---|---|
| #162 | CodeQL workflow — continuous TS/JS security analysis (security-extended query set), runs on every PR + weekly cron |
| #163 | Stripe webhook column-name production bug (`raw_payload` → `raw_event`) — schema mismatch meant every insert was failing with 500. Not yet exposed in prod (pre-customer) so no recovery needed |
| #164 | Stop-the-world admin gate at middleware + request-headers propagation fix + Tier-2 bypass hardened with VERCEL_ENV check |
| #165 | `tenantClient` fail-closed: throws `UnregisteredTenantTableError` for tables in neither set, plus 49 tenant-scoped tables registered, plus new `PLATFORM_READABLE_TABLES` set for cross-tenant reads with caller self-scoping |

### Audit findings status

| # | Source | Severity | Status |
|---|---|---|---|
| Auth #1 | Auth boundary | HIGH (10) | Fixed by #164 (stop-the-world bearer gate) — needs real §26 admin session gate to restore admin UI |
| Auth #2 | Auth boundary | HIGH (9) | Fixed by #164 (request-headers propagation) |
| Auth #3 | Auth boundary | MEDIUM | Hardened by #164 (VERCEL_ENV check on Tier-2 bypass) |
| Auth #4 | Auth boundary | MEDIUM | Open — CCPA cross-tenant delete |
| Auth #5 | Auth boundary | MEDIUM | Open — `assertPermission` is a stub |
| Auth #6 | Auth boundary | LOW | Open — `withPlatformAdminAudit` reason-detail bypass |
| Tenant #1 | Tenant isolation | HIGH (10) | Fixed by #165 (fail-closed proxy) |
| Tenant #2 | Tenant isolation | HIGH (10) | Fixed by #165 (tasks now properly scoped) |
| Tenant #3 | Tenant isolation | HIGH (10) | Fixed by #165 (task mutations now scoped) |
| Tenant #4 | Tenant isolation | HIGH (10) | Fixed by #164 (admin gate) |
| Tenant #5 | Tenant isolation | HIGH (7) | Fixed by #164 (request-headers propagation) |
| Stripe audit | Payments | (no HIGH findings) | All defense-in-depth observations noted in audit; raw_payload bug fixed in #163 |
| RAG audit | (in flight) | TBD | Agent running in background |

## Conflict + bug patterns observed during the cascade

Worth remembering for future merge waves:

1. **`packages/config/eslint-rules/no-direct-service-role-import.js`** conflicts on every rebase — keep both lists.
2. **`apps/main/src/app/api/inngest/route.ts`** conflicts on every rebase — keep both function registrations.
3. **`db/rls-exceptions.sql` ≠ `db/rls-exceptions.txt`** — RLS coverage check reads `.sql`, migration lint reads `.txt`. Keep in sync.
4. **Storage-bucket migrations** need `IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='storage') THEN ... END IF;` because CI's DB lacks the storage schema.
5. **`SECURITY DEFINER` migrations** must use `SET search_path = ''` + `REVOKE EXECUTE ... FROM public`.
6. **RLS coverage lint** scans only static `CREATE POLICY` blocks — no `DO $$ ... EXECUTE format() $$;` loops.
7. **Helper functions that take `svc` as a parameter** can route through `tenantClient` — every `.from(table)` they make must have the table in `TENANT_SCOPED_TABLES` or `PLATFORM_READABLE_TABLES`. Easy to miss in static grep.

## In flight

- **RAG-side security audit** — Agent running in background.
- **Auth #4 (CCPA tenant scope), §26 admin session gate, Auth #5 (RBAC)** — to be implemented this session.

## Next step

Continue the security fix wave:
1. Fix Auth #4 (CCPA cross-tenant delete) — quick (~30 min).
2. Build §26 admin session gate — restores admin UI.
3. Fix Auth #5 (assertPermission RBAC) — biggest impact, touches many routes.
4. Process RAG audit findings when agent reports.
5. Merge everything.

## Blocked on user

Nothing.

## Open questions

- After §26 admin gate ships, decide whether the bearer-token path stays (for service-to-service like RAG crons) or moves to a dedicated `/api/internal/*` namespace.
- After Auth #5 (real RBAC) ships, decide whether to enforce `withPlatformAdminAudit` reason-detail on all destructive reasons (Auth #6) or close the finding as wontfix.

## Carried forward (deferred work)

- BP39 follow-up: retroactive react-pdf wire-up to unblock help-docs PDF deferral
- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
