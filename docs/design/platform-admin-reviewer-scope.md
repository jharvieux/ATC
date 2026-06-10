# Scoped platform-admin access — reviewer role (#811)

**Status:** approved design, 2026-06-10. Ready to build (Sonnet).
**Decision owner:** operator — chose **reviewer-only scoping for now**; finance/support keep full
access until someone actually needs those roles narrowed.

## Problem

`assertPlatformAdmin` admits any `platform_admins` row to the entire `/admin` surface. The roles
(`superadmin | reviewer | finance | support`) are labels; the only per-role gate is
`assertSuperadmin` (admin management). The operator wants to grant a tenant owner
content-approval-only access without cross-tenant visibility.

## Scope decision

Only the **reviewer** role is narrowed in this pass:

| Role | Access |
|---|---|
| superadmin | everything (unchanged) |
| finance | everything (unchanged — explicit deferral, revisit when a finance-only admin exists) |
| support | everything (unchanged — same deferral) |
| service (bearer) | everything it has today (unchanged — it's the RAG reconciler path, not a human) |
| **reviewer** | **content approval only**: RAG Authority Overrides + Post-termination Chunks |

Reviewer surface, concretely:
- Pages: `/admin/rag/authority`, `/admin/chunks/post-termination`, and the `/admin` hub (filtered).
- API: `/api/admin/rag/*`, `/api/admin/chunks/*`.
- Everything else (tenants, abuse, denylist, admins, personas, legal, help-triage, resources,
  vendor-status, email-samples, integrations, reconciliation, settings, travel-news,
  retrieval-weights, supervisor) → 403 / hidden.

Note: `platform-admin-roles.ts` describes reviewer as "tenant onboarding review, content
moderation, and abuse signals" — broader than what the operator wants enforced. Update that
description string to match the enforced scope ("Platform content approval: RAG authority
overrides and post-termination chunks.") so the management UI doesn't promise access the role
doesn't have.

## Mechanism

Mirror `permission-grants.ts` with a platform-side matrix, but keyed on **admin resource**:

1. New `PLATFORM_ADMIN_GRANTS` in `apps/main/src/lib/auth/platform-admin-roles.ts`:
   - `superadmin`, `finance`, `support`, `service` → `"*"`.
   - `reviewer` → `new Set(["rag_authority", "post_termination_chunks"])`.
2. `assertPlatformAdmin(req, opts?: { resource: string })` gains an optional resource param.
   - With a resource: role must hold `"*"` or the resource → else `PlatformAdminError(403,
     "role_not_permitted")`.
   - Without a resource (transition state): behaves as today, BUT a lint-style guard (grep in CI
     or a unit test enumerating `/api/admin/**/route.ts`) asserts every admin route passes a
     resource, so the no-arg form can't silently persist. Default-deny is the end state.
3. Every `/api/admin/*` route passes its resource. Routes that switch on method/action keep
   one assert per semantic operation (D-091) — same resource, the action distinction stays with
   the role matrix being coarse (reviewer's two resources are approve-style surfaces; no
   read-vs-write split needed at this granularity).
4. Pages: the `(admin)` pages already call an admin gate server-side; they pass the same resource.
   Disallowed page → `notFound()`/redirect to `/admin` (which renders only permitted cards).
5. Sidebar + hub: filter `ADMIN_NAV_SECTIONS` / hub `SECTIONS` by the caller's role using the same
   matrix — single source of truth, no hand-maintained second list. Hiding is UX; the API/page
   gates are the enforcement (two layers).

## Not a migration

`platform_admins.role` already has the CHECK enum; no schema change. No Opus-audit trigger beyond
normal rules.

## Tests

- Reviewer session: 200 on `/api/admin/rag/authority` list, 403 on `/api/admin/tenants/*`,
  `/api/admin/abuse/*`, `/api/admin/admins/*`.
- Superadmin unchanged across the board.
- Enumeration test: every `/api/admin/**/route.ts` calls `assertPlatformAdmin` with a resource
  (this is the test that encodes WHY — the surface must be default-deny for scoped roles, so an
  unannotated new route must fail CI, not silently admit reviewers).

## Follow-up (separate issues when needed)

- Finance/support matrices (this design's matrix structure already accommodates them).
- Scoping the `service` bearer to its actual reconciler routes.
