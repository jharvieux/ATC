# Session state — last updated 2026-05-25 ~14:55 UTC

## Just completed — full security audit wave is closed

Three parallel Agent audits (auth boundary, tenant isolation, Stripe/payments) plus a fourth on the RAG service surfaced 16 findings across 4 subsystems. Every HIGH-confidence finding has been fixed, every MEDIUM has been fixed, the one LOW has been fixed, and CodeQL is now live for continuous coverage.

### Security PRs landed on `dev`

| PR | What |
|---|---|
| #162 | CodeQL workflow — TS/JS security-extended query suite, every PR + weekly cron |
| #163 | Stripe webhook column-name production bug (`raw_payload` → `raw_event`) — discovered during the audit, prevented every webhook from inserting |
| #164 | Stop-the-world admin gate at middleware + request-headers propagation fix + Tier-2 bypass hardened with `VERCEL_ENV` check |
| #165 | `tenantClient` fail-closed: throws on unregistered tables, registers 49 tenant-scoped + 8 platform-readable tables |
| #166 | First docs checkpoint (D-083) |
| #167 | CCPA tenant scope (Auth #4) + 4 RAG admin platform-admin gates + Inngest signing-key fail-loud (5 audit findings) |
| #168 | Real §26 admin session gate: `platform_admins` table + `assertPlatformAdmin` helper + 26 admin routes converted off `x-admin-user-id` |
| #169 | RBAC matrix in `assertPermission` (Auth #5) — 3 roles × 51 grants, `users.role` column, fail-closed on unknown |
| #170 | Auth #6 (reason-detail tightening) + `respondToAuthError` helper used by 66 routes + 9 admin React pages migrated to Supabase session bearer |
| #171 | Role-assignment UI: `/settings/users` page + `GET /api/tenant/users` + `PATCH /api/tenant/users/[id]/role` |

### Final audit findings status

| # | Source | Severity | Status |
|---|---|---|---|
| Auth #1 (admin gate) | Auth | HIGH | Fixed (#164 stop-the-world; #168 real session gate; #170 admin UI migration) |
| Auth #2 (middleware header) | Auth | HIGH | Fixed (#164) |
| Auth #3 (Tier-2 bypass) | Auth | MEDIUM | Hardened (#164) |
| Auth #4 (CCPA tenant scope) | Auth | MEDIUM | Fixed (#167) |
| Auth #5 (RBAC stub) | Auth | MEDIUM | Fixed (#169) — role-assignment UI shipped in #171 |
| Auth #6 (audit reason-detail bypass) | Auth | LOW | Fixed (#170) |
| Tenant #1 (proxy fail-open) | Tenant | HIGH | Fixed (#165) |
| Tenant #2-3 (tasks cross-tenant) | Tenant | HIGH | Fixed (#165 by closing #1) |
| Tenant #4-5 (admin/header) | Tenant | HIGH | Fixed (#164) |
| Stripe (raw_payload prod bug) | Stripe | n/a (correctness) | Fixed (#163) |
| RAG #1-4 (admin gate misses) | RAG | HIGH | Fixed (#167) |
| RAG #5 (Inngest signing key) | RAG | MEDIUM | Fixed (#167) |

### Manual step required after deploy

Seed the first platform admin. From the dev DB (or whichever environment):

```sql
INSERT INTO platform_admins (auth_user_id, role, email)
VALUES ('<your-supabase-auth-user-uuid>', 'superadmin', '<your-email>');
```

Once that row exists, you can log into the admin React pages with that Supabase account and the new session gate (#168) will recognize you. Until you seed at least one row, only the service-to-service Bearer (RAG cron, etc.) can call `/api/admin/*`.

## In flight

**Nothing in flight.** Working tree clean.

## Next step

Whatever's next on the product backlog. The security audit follow-ups are closed.

A few low-priority artifacts worth queuing whenever:
- **Test-environment gating gaps** — the Stripe webhook integration test + cross-tenant probe both `describe.skip` silently when their credentials aren't set. Worth either failing CI loudly on PRs touching their domain, or wiring the credentials in CI secrets.
- **Ownership transfer endpoint** — the `/api/tenant/users/[id]/role` route blocks self-demotion. Long-term, owners need a way to hand the tenant off to someone else. Out of scope for the RBAC PR; will land when there's a product use case.
- **Required-check promotion for CodeQL** — currently CodeQL runs on every PR but isn't required. Observe a few runs before promoting to required.

## Blocked on user

Nothing.

## Open questions

- After the §26 admin session gate ships (#168), should the bearer-token Bearer path stay (RAG crons use it) or move to a dedicated `/api/internal/*` namespace? Today both paths share `/api/admin/*`. Cosmetic.
- Should Playwright become a required check after the BP38 quotes regression and supervisor-sampling flake stayed fixed for several PRs? Both have been green for the last ~8 merges.

## Carried forward (deferred work, not security)

- BP39 follow-up: retroactive react-pdf wire-up to unblock help-docs PDF deferral
- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
