# Session state — last updated 2026-06-25 20:07 UTC

## Just completed

- **PR #1437** — AdminHeaderMenu: avatar trigger + staff nav; fix "Could not load dashboard data" 403. Merged.
  - Trigger: avatar → initials → Menu icon (matches SiteHeaderMenu)
  - Staff nav: hamburgerSectionsForRole("tenant_owner") sections (Dashboard, My account), CRM, Platform Admin — no section headers
  - Root cause of dashboard error: migration 20260628000002 changed users.role DEFAULT to 'viewer'; auth callback upsert doesn't set role explicitly, so a new platform admin login created a viewer row → assertPermission(TenantUsage:read) failed
  - Fix: migration 20260712000000 — promotes existing under-privileged rows + BEFORE INSERT trigger to enforce tenant_owner for platform admins in platform-internal tenants going forward

## In flight

Nothing in flight — clean checkpoint.

## Next step

Run auto-triage at next session start to pick up any new open issues.

## Blocked on user

Migration 20260712000000 needs to be applied to production Supabase. Once the PR is deployed, the migration will run automatically via the CI/CD pipeline on merge to dev → staging → prod.

## Open questions

- 40 pre-existing `String(err)` egress sites baselined in `scripts/error-message-egress-baseline.txt`. Frozen debt on the same burn-down track as #1395. No tracking issue yet.
