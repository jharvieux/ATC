# Onboarding-funnel audit (issue #1161)

One-time deliberate sweep of the onboarding + tenant-lifecycle surface for latent
bugs, run 2026-06-16. Scope: sign-up → tenant create → Stripe Connect onboarding +
return → first login → dashboard load → first permission-gated action → first
booking/quote. Five audit dimensions per step. "No findings" is recorded
explicitly so a future reader knows the step was walked, not skipped.

Source schema: live `tenants`/`tier_definitions`/`legal_documents`/`personas`
columns verified against `mcp__supabase-main list_tables` (264k snapshot, 2026-06-16).

---

## Summary

**One concrete bug found** (Finding 1) — every other step × dimension cell is clean.

| Dimension | Result |
|---|---|
| 1 — Reader/column correctness | **1 finding** (persona PATCH selects nonexistent `tenants.tier`). Dropped-column + embed classes clean. |
| 2 — Host/tenant resolution in redirects | Clean. All onboarding redirect builders use `tenantOriginFromRequest(req)`. |
| 3 — Permission matrix | Clean. `pnpm check:permission-matrix` green; every funnel route's pair present in `permission-grants.ts`. |
| 4 — Pricing/tier source of truth | Clean. Single authority chain `tier_id → tier_definitions.code → CODE_TO_TIER → priceIdFor`. |
| 5 — Auth/session edge cases | Clean. #1045/#1049/#1050/#1055/#1104 all intact in current code. |

---

## Findings

### Finding 1 — Persona override PATCH selects nonexistent `tenants.tier` → always 404

- **Where:** `apps/main/src/app/api/tenant/personas/[slug]/route.ts:47`
- **Class:** Dimension 1 — misnamed/nonexistent column (the #1160 class; NOT covered
  by the dropped-column guard, which is table+string aware but only flags columns
  that were *dropped*, not columns that never existed).
- **Bug:** The PATCH handler runs
  `db.from("tenants").select("id, tier, background_ai_enabled")`. The `tenants` table
  has **no `tier` column** — tier is stored as `tier_id` (FK to `tier_definitions`).
  PostgREST returns a 400 for the unknown column, so `tenantErr` is always truthy and
  the handler returns `{ error: "tenant_not_found" }` (404) on **every** call.
- **Symptom:** Editing any persona override (display name, system-prompt addendum,
  disable toggle) from tenant settings fails 100% of the time with a 404. Feature is
  fully broken, not degraded.
- **Why tsc can't catch it:** column names are plain strings inside the Supabase
  query chain.
- **Fix (non-trivial — separate PR):** select `tier_id`, resolve it to
  `tier_definitions.code`, and pass the **code string** to `upsertPersonaOverride`.
  That helper gates on `ALLOW_DISPLAY_NAME_OVERRIDE_TIERS` / `ALLOW_ADDENDUM_TIERS`
  (`{sub_agency, byo_agency}`), so it needs the type-prefixed tier *code*, not the
  bare tier name. Mirror the resolution already done correctly in
  `app/api/onboarding/subscription/checkout/route.ts:33-43`.
- **Filed as:** #1183

---

## Step × dimension walk

Legend: ✅ no findings · 🐞 finding (see above).

### Step 1 — Sign-up (`/signup`, `/signup/complete`, `/api/auth/signup/complete`)

- **Dim 1** ✅ `signup/complete/route.ts` provisions tenant; reads/writes match schema.
- **Dim 2** ✅ Platform-domain guard present; no cross-host redirect built here.
- **Dim 3** ✅ Pre-auth route (no `assertPermission`); membership upsert sets
  `tenant_owner` explicitly.
- **Dim 4** ✅ No tier/pricing read at this step.
- **Dim 5** ✅ Fail-closed idempotency on provisioning; `progressTo` signup→profile→legal.
  Deep-link login gate covered by proxy (see Step 4 / #1050).

### Step 2 — OAuth callback (`/api/auth/callback`)

- **Dim 1** ✅ Membership upsert columns match schema.
- **Dim 2** ✅ Relative `next` redirect; agency-provisioning skip (`next=/signup/complete`,
  #800/#441) intact.
- **Dim 3** ✅ Pre-auth; role defaults to `viewer` (upsert skips role).
- **Dim 4** ✅ n/a.
- **Dim 5** ✅ PKCE exchange; no session leakage path.

### Step 3 — Tier select (`/api/onboarding/tier`)

- **Dim 1** ✅ Reads `tenant_type`; resolves `tier_definitions.id` by prefixed code;
  CAS update via `safeAwaitRowCount(..., 1)`.
- **Dim 2** ✅ No absolute URL built.
- **Dim 3** ✅ `assertPermission(onboarding, tier:select)` — pair present in grants.
- **Dim 4** ✅ Tier code resolved through `TIER_CODE[tenant_type][tier]` (single authority).
- **Dim 5** ✅ `progressTo(..., "subscription")` one-step transition.

### Step 4 — Subscription checkout (`/api/onboarding/subscription/checkout`)

- **Dim 1** ✅ Service-role read of `tenants(id, tenant_type, tier_id, seat_count,
  billing_period, stripe_customer_id)` — all real columns; resolves `tier_id` →
  `tier_definitions.code`.
- **Dim 2** ✅ `baseUrl = tenantOriginFromRequest(req)`; success/cancel URLs on tenant host.
  BYO→`/onboarding/branding`, sub→`/onboarding/connect` (correct per advanceByo).
- **Dim 3** ✅ `assertPermission(onboarding, subscription:setup)` — pair present.
- **Dim 4** ✅ `CODE_TO_TIER` → `priceIdFor` (throws loudly on missing mapping/env).
- **Dim 5** ✅ 30-day trial guard prevents pre-activation billing; tenant-host redirect
  keeps session/tenant resolution intact. Login gate for `/onboarding/*` enforced in
  `proxy.ts` `isLoginGatedPath` (#1050, intact — redirects unauthenticated deep-links
  to `/auth/reauth?return=…` before tenant resolution).

### Step 5 — Stripe Connect link + return (`/api/onboarding/connect/link`)

- **Dim 1** ✅ Reads/writes `stripe_connect_account_id` (real column).
- **Dim 2** ✅ `refresh_url`/`return_url` built from `tenantOriginFromRequest(req)`
  (#1131/#1132/#1133 class — clean).
- **Dim 3** ✅ `assertPermission(onboarding, connect:setup)` — pair present.
- **Dim 4** ✅ n/a.
- **Dim 5** ✅ `safeAwait` on the account-id persist; idempotent (reuses existing account).

### Step 6 — First login / dashboard load / first permission-gated action

- **Dim 1** ✅ No funnel reader selects a nonexistent column except Finding 1
  (whole-surface grep of `from("tenants")` + bare-`tier` select; only the persona
  route hit). `cruise_lines.tier` (`/api/admin/cruise-catalog/lines`) is a real column,
  not a funnel route — dismissed.
- **Dim 2** ✅ Chat/tenant-resolution path on platform domain falls back to `platform`
  sentinel safely; ICA reauth redirect (`onboarding/ica/page.tsx:80-82`) intact (#1104).
- **Dim 3** ✅ `pnpm check:permission-matrix` passes (247 routes); every
  `assertPermission` pair in the funnel resolves in `permission-grants.ts` (post-#1173/#1176).
- **Dim 4** ✅ n/a.
- **Dim 5** ✅ #1055 (`legal_documents` in `PLATFORM_READABLE_TABLES`) intact; admin page
  gate (`isAdminPagePath`) returns 404 to anonymous/cross-host.

### Step 7 — First booking / quote

- **Dim 1** ✅ No nonexistent-column reader found in booking/quote funnel entry.
- **Dim 2** ✅ No absolute-URL builder in scope.
- **Dim 3** ✅ Booking/quote routes' permission pairs present (matrix guard green).
- **Dim 4** ✅ Pricing reads resolve through the same single authority.
- **Dim 5** ✅ Tenant-scoped reads carry both app-layer filter and DB constraint.

---

## Gate coverage (what catches each class going forward)

| Bug class | Gate | Covers Finding 1? |
|---|---|---|
| Reader names a **dropped** column | `pnpm check:dropped-columns` (CI "Dropped-column reader guard") — table-aware, whole-word | ❌ — `tier` was never on `tenants`, so it's not in the dropped-column set |
| Reader names a **nonexistent/misnamed** column (#1160 class) | **No mechanical gate today** | ❌ — this is the gap Finding 1 lives in |
| PostgREST **embed** points at missing FK/table | embed-lint | n/a (no funnel embeds) |
| Schema drift (migration vs app) | schema-drift check | partial |
| `assertPermission` pair missing from grants | `pnpm check:permission-matrix` (CI "Permission-matrix guard") | ✅ for dim 3 |
| Funnel regressions end-to-end | e2e smoke (bypasses `isPermitted` via `role=tenant_owner`) | ❌ — would not have caught Finding 1's 404 unless the smoke asserts persona PATCH succeeds |

**Gap to track:** the misnamed/nonexistent-column class (Finding 1) has no static
backstop. The dropped-column guard only knows about columns that once existed and were
dropped. A guard that validates every `.select("…")` column-list against the live
`information_schema` for the chained `.from("<table>")` would close this class
(superset of `check:dropped-columns`). Tracked as a follow-up issue (see below).

---

## Follow-ups filed

- **#1183** — persona PATCH 404 (Finding 1; file paths + repro above).
- **#1184** — gate gap: no static guard for nonexistent/misnamed `.select` columns
  (#1160 class); proposal: extend the column guard to validate against live
  `information_schema`.
