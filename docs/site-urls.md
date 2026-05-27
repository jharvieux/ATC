# Site URLs

Browser-accessible pages, grouped by the host context that resolves them.
API routes (`/api/**`) are excluded — they're called by the app, not navigated to.

## Host resolution

The proxy (`apps/main/src/proxy.ts`) reads the request `Host` header,
strips the port, and routes by hostname:

| Host pattern | Resolves to | Example (local dev) | Example (production) |
|---|---|---|---|
| `<PLATFORM_PRIMARY_DOMAIN>` (bare) | Platform admin | `http://localhost:3000` | `https://aitravelconcierge.com` |
| `<slug>.<PLATFORM_PRIMARY_DOMAIN>` | Tenant by slug (via `getTenantBySlug`) | `http://acme.localhost:3000` | `https://acme.aitravelconcierge.com` |
| custom domain | Tenant by full hostname (BYO-host) | n/a | `https://book.acme.com` |

Local-dev quirks:

- macOS resolves `*.localhost` to 127.0.0.1 automatically — no `/etc/hosts` edits needed.
- Tenant subdomains require a seeded tenant row in Supabase. With nothing seeded, `<slug>.localhost:3000` returns 404 because the proxy can't resolve the slug.
- The bare `localhost:3000` (platform context) always works because it skips the DB lookup.

Route groups in the file tree (`(admin)`, `(onboarding)`, `(tenant)`) are organizational only and do not appear in the URL. The URL is the path with parentheses-wrapped segments removed.

---

## Public pages (any host)

| URL | Page |
|---|---|
| `/` | Landing page |
| `/signup` | Subhost signup (start) |
| `/signup/email-prompt` | Signup email capture step |
| `/consent` | Cookie-consent capture |
| `/auth/reauth` | Re-authentication |
| `/auth/transfer-consent` | Cross-host consent transfer |
| `/legal/ai-disclaimer` | AI liability disclaimer |
| `/legal/sub-processors` | Sub-processors list |
| `/email/unsubscribe-confirmed` | Email-unsubscribe landing |

## Token-bearing public links (any host, HMAC-validated server-side)

| URL pattern | Spec | What it is |
|---|---|---|
| `/i/[token]` | BP39 §39.2.6 | Public itinerary view (booking details + agent notes) |
| `/group/invite/[token]` | §18.5 | Group invitation — validates token, shows cabin grid, RSVP buttons |
| `/companion/[token]` | §23.5 | Pre-cruise companion content (image galleries, itineraries) |

---

## Platform admin pages

**Host:** bare `<PLATFORM_PRIMARY_DOMAIN>` (e.g. `localhost:3000` in dev).
**Context:** resolved-tenant-id header is `platform`.

| URL | Page |
|---|---|
| `/supervisor` | Supervisor dashboard — kill switch, escalations, drift trend |
| `/admin/abuse-monitoring` | Cross-tenant abuse summary |
| `/admin/abuse-monitoring/[tenant_id]` | Per-tenant abuse drill-in |
| `/admin/chunks/post-termination` | Post-termination chunk inventory |
| `/admin/denylist` | Denylist editor |
| `/admin/help-triage` | Help-AI triage queue |
| `/admin/help` | Help-AI overview |
| `/admin/help/phase-2-readiness` | Phase-2 readiness checklist |
| `/admin/help/print` | Help-AI printable view |
| `/admin/legal-docs` | Legal documents management |
| `/admin/rag/authority` | RAG authority overrides |
| `/admin/retrieval-weights` | RAG retrieval-weight tuning |
| `/admin/tenants/review-queue` | New-tenant review queue |
| `/admin/vendor-status` | Vendor health board |

---

## Tenant pages

**Host:** `<slug>.<PLATFORM_PRIMARY_DOMAIN>` or a configured custom domain.
**Context:** resolved-tenant-id header is the tenant UUID. Payment-gate banner state is also set here.

### Onboarding (post-signup, pre-active)

| URL | Step |
|---|---|
| `/onboarding/tier-select` | Pick subscription tier |
| `/onboarding/ica` | Independent Contractor Agreement |
| `/onboarding/legal` | Legal acceptance |
| `/onboarding/profile` | Profile setup |
| `/onboarding/branding` | Branding setup |
| `/onboarding/state-of-operation` | State of operation |
| `/onboarding/tax-form` | Tax form (W-9 / W-8) |
| `/onboarding/connect` | Stripe Connect onboarding |
| `/onboarding/subscription` | Stripe subscription |
| `/onboarding/review-submitted` | Final review-pending screen |

### CRM (subhost operator)

| URL | Page |
|---|---|
| `/crm/contacts` | Contacts list |
| `/crm/contacts/new` | New contact form |
| `/crm/contacts/[id]` | Contact detail |
| `/crm/imports` | Document/email import queue |
| `/crm/imports/[id]` | Import-item review screen |
| `/crm/imports/manual` | Manual import entry |
| `/crm/quotes` | Quotes list |
| `/crm/quotes/[id]` | Quote detail |
| `/crm/components` | Components bulk view across all bookings (BP40 §40.5.3) |
| `/crm/rag/queue` | RAG curation queue |
| `/crm/reports` | Reports index |
| `/crm/reports/bookings-by-source` | Bookings by attribution source |
| `/crm/reports/campaigns` | Campaign performance |
| `/crm/reports/cancellations` | Cancellation analytics |
| `/crm/reports/first-vs-last-touch` | First-vs-last-touch attribution |
| `/crm/reports/leads-by-source` | Leads by attribution source |
| `/crm/reports/source-funnel` | Attribution-source funnel |

### Settings (subhost operator)

| URL | Page |
|---|---|
| `/settings/ai-mode` | AI mode + behavior toggles |
| `/settings/billing` | Stripe billing |
| `/settings/branding` | Branding |
| `/settings/host-integration` | BYO-host integration config |
| `/settings/personas` | AI personas |
| `/settings/subcontractors` | Sub-contractor management |
| `/settings/usage` | Usage / cost dashboard |
| `/settings/users` | User management |

### Tenant admin (owner-only)

| URL | Page |
|---|---|
| `/tenant-admin/chat-limits` | Per-tenant chat rate limits |
| `/tenant-admin/crm/anonymized-notes` | Anonymized notes audit |
| `/tenant-admin/safety` | Safety / abuse controls |

### End-user (customer) pages

| URL | Page |
|---|---|
| `/chat` | AI chat interface |
| `/booking/flow/[id]/[stage]` | Multi-stage booking flow |
| `/groups/[id]/coordinate/[tab]` | Group coordinator dashboard |
| `/group/invite/[token]` | (also listed above as a token link) Group RSVP |
| `/settings/price-watches` | Customer price watches |
| `/settings/privacy` | Customer privacy settings |
| `/settings/privacy/cookies` | Cookie preferences |

---

## Notes

- This is the static route inventory. Whether a route is actually reachable for a given user depends on `assertPermission()` checks at the page level, the tenant's payment-gate state (see `derivePaymentState`), and onboarding status.
- API route inventory lives in code under `apps/main/src/app/api/**/route.ts`. Generate a current list with `pnpm tsx scripts/enumerate-api-routes.ts` (see `scripts/`).
- When adding a new page, update this doc in the same PR. CLAUDE.md treats this as part of the route's surface area.
