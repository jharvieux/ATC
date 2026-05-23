# Four-layer authentication & authorization

> Spec ref: §26.2.

Every request that touches tenant-scoped data passes four layers. Skipping any one of them creates a class of bug that the others don't catch.

## The four layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1 — Identity                                             │
│    Who is the caller? (Supabase Auth JWT for users; service     │
│    JWT or webhook signature for non-users.)                     │
│    Code: assertPermission() resolves the JWT via Supabase.      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2 — Tenant context                                       │
│    Which tenant is being acted on? Resolved from the request    │
│    host (middleware) OR from event payloads (Inngest) OR from   │
│    webhook metadata (Stripe/Resend).                            │
│    Code: tenantContextFromRequest / tenantContextFromInngest /  │
│          tenantContextFromStripeEvent / ...FromResendEvent      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3 — Authorization                                        │
│    Is this caller allowed to do this action on this tenant?     │
│    Today: membership + status check. Future: full RBAC matrix.  │
│    Sensitive actions also require auth_time ≤ 4h (§26.3).       │
│    Code: assertPermission(opts) + AuthReauthRequired.           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4 — Data access scoping                                  │
│    Every DB query is automatically tenant-scoped via            │
│    tenantClient(ctx) — the proxy injects tenant_id.             │
│    Platform-admin paths use withPlatformAdminAudit; service-    │
│    role construction outside those two factories is lint-       │
│    forbidden (§26.3a).                                          │
└─────────────────────────────────────────────────────────────────┘
```

## What fails open if you skip a layer

| Skipped | Failure mode |
|---|---|
| Layer 1 | Anonymous access to authenticated endpoints. |
| Layer 2 | Cross-tenant leak — caller acts on tenant Y while authenticated as a member of tenant X. |
| Layer 3 | Privilege escalation — member with read-only role performs writes; stale session performs sensitive action. |
| Layer 4 | Raw service-role queries bypass RLS — every SELECT can see every tenant. |

## Non-HTTP contexts

Inngest jobs and webhooks don't have an HTTP request with a user JWT. They substitute Layer 1+2 with the appropriate `TenantContext` factory from `lib/db/factories.ts`:

- **Inngest:** `tenantContextFromInngestEvent(event)` — reads `event.data.tenant_id` (spec §11.2.2 / §5.4.5 mandatory contract).
- **Stripe:** `tenantContextFromStripeEvent(event)` — resolves via `tenants.stripe_connect_account_id` or `tenants.stripe_customer_id`. Audit row written on every resolution per §26.3a.4.
- **Resend:** `tenantContextFromResendEvent(event)` — resolves via `email_log.resend_message_id`. Audit row written.

These factories DON'T skip Layers 1+2 — they substitute a different identity / tenant source. Layers 3+4 still apply.

## Related code

| Layer | File |
|---|---|
| 1 | `apps/main/src/lib/auth/assert-permission.ts` |
| 2 | `apps/main/src/lib/db/factories.ts` |
| 3 | `apps/main/src/lib/auth/assert-permission.ts` + `apps/main/src/lib/auth/sensitive-routes.ts` |
| 4 | `apps/main/src/lib/db/tenant-client.ts` + `apps/main/src/lib/db/platform-admin-client.ts` |
| All | ESLint rules: `atc/no-direct-service-role-import`, `atc/no-direct-service-role-env-import`, `atc/platform-admin-functions-must-use-audit-wrapper`, `atc/no-ad-hoc-tenant-id-string` (staged), `atc/no-direct-anthropic-or-openai-import` (staged) — see `docs/exceptions-service-role.md`. |
