# Personal API tokens — Settings → Integrations (#712)

**Status:** approved design, 2026-06-10. Ready to build (Sonnet; migration triggers Opus FIRST AUDIT).
**Decision owner:** operator — chose **tenant-admin-only minting**.

## Problem

The iOS Shortcut and similar automations (`docs/ios-shortcut.md`) need a long-lived Bearer token
for `/api/rag/submit/ios-shortcut` and `/api/rag/submit/extension`. The only path today is
extracting a ~1-hour session JWT from devtools.

## Decisions

- **Who mints:** tenant admins (`tenant_owner` role) only, from Settings → Integrations. An admin
  may mint a token for themself or for any active member of the tenant; the token **acts as that
  member** — RBAC at the member's role, plus the token's own scope ceiling.
- **Expiry:** none. Tokens live until revoked. Safety net = revocation UI, `last_used_at`
  visibility, and the narrow default scope.
- **Scopes (v1):** `rag_submissions:create` only. The scope set is a ceiling on top of the user's
  role grants: a request must pass BOTH `isPermitted(role, resource, action)` AND
  `scopes` containing `resource:action`. New scopes are added when a real automation needs them.

## Token format and storage

- Raw token: `atc_pat_` + 32 random bytes, base64url. The prefix lets the bearer path detect a
  PAT without a failed JWT parse, and lets secret scanners fingerprint leaks.
- Store only `sha256(raw)` in `token_hash` (unique index — the lookup key). Raw value is shown
  once at creation, never again.

## Schema (per the issue, plus audit columns)

```sql
CREATE TABLE personal_access_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- who the token acts as
  created_by_user_id  uuid NOT NULL REFERENCES users(id),                    -- the admin who minted it
  name                text NOT NULL,
  token_hash          text NOT NULL UNIQUE,
  scopes              text[] NOT NULL DEFAULT ARRAY['rag_submissions:create'],
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz
);
```

RLS: deny-all + service-role grant only. All reads/writes go through API routes gated by
`assertPermission` (resource `api_tokens`, actions `list` / `create` / `revoke`, granted to
`tenant_owner` only in `permission-grants.ts`). Regenerate the grants snapshot.

## Auth path (assertPermission integration)

In the existing bearer branch of `assertPermission` (`apps/main/src/lib/auth/assert-permission.ts`):

1. If the bearer token starts with `atc_pat_`: hash it, look up `personal_access_tokens` by
   `token_hash` via service-role (constant-time is provided by the hash — no prefix matching).
2. Reject (401) when: no row, `revoked_at` set, row's `tenant_id` ≠ resolved request tenant.
3. Load the `users` row for `user_id`; reject unless `status = 'active'` (a deactivated member's
   tokens die with them — no separate cleanup needed, but revoke-on-removal is a nice-to-have).
4. Enforce scope ceiling AND role RBAC as above.
5. Sensitive routes (§17.7) stay hard-blocked for all bearer auth — already the case.
6. `last_used_at`: `await` an update (no `void` in serverless — D-091), throttled to at most one
   write per ~5 minutes per token (skip the write if `last_used_at` is fresh) so the hot path
   isn't a write-per-request.
7. Non-PAT bearer tokens fall through to the existing session-JWT path unchanged.

Note: PATs do not satisfy the consent-pending gate differently — pending consent still blocks
(same as the session-JWT bearer path today).

## UI — Settings → Integrations

- Table: name, acting member, created by, created date, last used, status (active/revoked).
- "Generate token" (admin-only button): name + member picker (defaults to self) → modal shows the
  raw token once with copy button and a "store this now" warning.
- Revoke: sets `revoked_at` (use `safeAwaitRowCount` — zero-row update must raise, D-091).
- Page itself: any member can VIEW tokens that act as them; only admins see/manage all and mint.

## Acceptance criteria (from the issue, amended)

- Tenant admin generates a named token from Settings → Integrations (member picker, default self).
- Token shown once; works as Bearer on `/api/rag/submit/ios-shortcut` and `…/extension`.
- Revocation immediate; revoked token → 401.
- `last_used_at` visible and updated (throttled).
- `docs/ios-shortcut.md` Step 1 rewritten for the UI flow.
- Tests: hash lookup, revoked rejection, wrong-tenant rejection, scope-ceiling denial (a PAT with
  rag scope hitting a non-rag mutating route → 403), inactive-member rejection.
