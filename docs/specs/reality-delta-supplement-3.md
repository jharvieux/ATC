# Spec gap analysis — supplement #3 to reality-delta.md

Decisions logged in `MEMORY.md` **since the 2026-05-27/28 sweep** (supplement #2 + the post-sweep additions at the tail of `reality-delta.md`) that imply a tech-spec edit. Reviewed range: **D-118 → D-124**.

Same conventions as the prior delta docs: append-only; reference **MEMORY D-NNN** + **PR number**; each entry's `Action for spec update` line says exactly what to change; `> **Closed YYYY-MM-DD in #PR**` on resolution.

---

## How this supplement was scoped

Walked every MEMORY entry from D-118 (first decision after the last sweep) through D-124 (latest). Classified each as **spec-relevant** (needs a spec edit — included below) or **no spec impact** (CI/test/process — listed at the bottom for completeness so a future sweep doesn't re-investigate).

---

## Critical-path findings

### §7.1 / §17.1–§17.7 / §26.3 — Auth session boundary rewritten: HttpOnly cookies + PKCE, not `Authorization: Bearer` + localStorage

- **Spec says:** §17 describes OAuth with the implicit flow; the client receives an access token and the session is carried as `Authorization: Bearer <token>` with the token persisted in `localStorage`. §7.1 / §26.3 prose assumes the Bearer-header session model when describing how `/api/auth/me`, `assertPermission`, and the platform-admin gate read identity.
- **Reality (D-122, PR #443):** The entire session boundary migrated to the `@supabase/ssr` cookie-adapter **PKCE** flow. Session bytes live in **HttpOnly cookies** the browser cannot read. The server reads them through three named factory clients (request-scoped read-only, route-handler read+write-capture, middleware refresh). `proxy.ts` calls `supabase.auth.getUser()` on every request and flushes rotated cookies onto every post-refresh response branch. `tenantContextFromRequest` and `assertPermission` keep their `(req: Request)` signatures (so ~147 call sites are untouched) but internally swap createClient+Bearer for `createRequestScopedClient`. The old implicit-flow `#access_token=…` URL-fragment primitive is gone (it was the root cause of the "OAuth%20failed#access_token=…" Google-login bug).
- **Risk if spec isn't updated:** §17 actively documents the wrong (less-secure, removed) scheme. A future engineer reading §17 would re-introduce the Bearer/localStorage pattern. Security posture in the spec understates the actual XSS-hardening (HttpOnly).
- **Action for spec update:**
  - **§17.1–§17.3** — rewrite the OAuth/session prose to describe PKCE + HttpOnly cookie sessions via `@supabase/ssr`. Name the three factory clients and the middleware-refresh requirement (Supabase rotates the refresh token on every use, so middleware refresh is mandatory or sessions die at the 1h access-token mark).
  - **§17.4 / §17.7** — consent renewal + sensitive-action re-auth read the session from cookies now, not a Bearer header.
  - **§7.1** — `/api/auth/me` returns identity from the cookie session.
  - **§26.3** — the platform-admin gate verifies the Supabase session JWT from cookies, then looks up `platform_admins`.
  - Add a threat-model note: HttpOnly defeats XSS token theft; cookies travel automatically on same-origin fetches.

#### Sub-deltas folded into the §17 rewrite

- **`/auth/error` page added** (D-121, PR earlier in the same arc): §17 should document the OAuth-failure landing page. The Supabase `state` clobber that broke Google login was also fixed.
- **Deferred — "return to original page" re-auth → #437.** §17.7 prose describing post-re-auth redirect-to-origin should carry `> **Status (2026-05-29):** Deferred to #437.`
- **Deferred — signup / tenant provisioning under the new flow → #441.** Net-new tenant signup has no UI caller today; orthogonal to login.
- **Deferred — anonymous-session cookie HMAC + HttpOnly hardening → #442.** The third sub-item of #64; needs HMAC infra + a migration plan for already-set unsigned cookies. §11.4 / §24.x anon-session prose should note the hardening is pending.

---

### §23.4 — Pre-cruise emails now carry a destination hero image + a full-cruise weather chart; "weather for all stops" is implemented (Open-Meteo)

- **Spec says:** §23.4's T-1 row lists "weather for all stops" as a content component but names no provider, and the implementation shipped with a `TODO(weather-integration)` placeholder (the section was simply omitted when weather wasn't configured). §23.4 does NOT mention destination imagery at all.
- **Reality (D-124; PRs #469 helper+cache, #470 admin+alert, #482 templates):**
  - **Weather is live via Open-Meteo** (free tier, 10k req/day, CC-BY 4.0). A multi-day forecast chart renders on **both T-7 and T-1**, one column per cruise day, covering sea days via straight-line interpolation. Open-Meteo CC-BY 4.0 attribution is required and rendered beneath the chart. A platform-admin page at `/admin/integrations/weather` exposes usage + an operator-tunable daily cap; the helper fails closed on a DB read error.
  - **Destination hero images** (net-new, not in spec): each pre-cruise email (T-90/30/7/1) renders a region-appropriate hero image (beach for Caribbean, glacier for Alaska, etc.) with photographer attribution in the footer.
  - **PortInfo terminal addresses + parking info** now actually render in T-1 (the `PortInfo` interface carried these fields but the template never read them until PR #482).
- **Action for spec update:**
  - **§23.4** — name Open-Meteo as the weather provider; document the multi-day chart on T-7 + T-1 (not just T-1), the sea-day interpolation rule (linear midpoint between bracketing ports), and the CC-BY 4.0 attribution requirement.
  - **§23.4** — add prose for the destination hero image: region classification by **first port of call** (not embarkation port), CruiseMapper title-embedded region as primary signal + static first-stop lookup as backup.
  - **§23.4** — note the daily-cap rate-limit gate + the `/admin/integrations/weather` operator surface.
- **Still-open prerequisites for full prod wiring (issues, not spec deltas):** #483 (phantom column fix), #484 (port lat/lon), #485 (CruiseMapper sailing parser — per-day itinerary not captured today), #486 (region classifier + sea-day interp), #487 (wire-up + 8 more region images). Until these land, the templates support the features but the production sender doesn't populate them.

---

### §33.6.1 — `rag_media_assets` extended with region scope for destination images

- **Spec says:** §33.6.1 defines `rag_media_assets` for hot-linked images tied to a specific **entity**: `entity_type IN ('ship','port','deck','cruise_line')`, `kind IN ('deck_plan','ship_photo','port_map','other')`.
- **Reality (D-124, PR #482, RAG migration 0019):** `entity_type` now also accepts `'region'` and `kind` now also accepts `'destination_hero'`, so a category-level marketing image (one per cruise region) can be stored and retrieved by `entity_id = 'caribbean'` etc. A partial unique index enforces one global `destination_hero` per region. A static catalog mirror at `apps/main/src/lib/cruise-regions/destination-images.ts` is what the email-render path reads (no per-render network call); the RAG rows are the canonical store + future per-tenant override surface.
- **Action for spec update:** §33.6.1 — extend the documented `entity_type` and `kind` enums to include `'region'` / `'destination_hero'`. Note the static-catalog-mirror pattern and that per-tenant overrides (scope='tenant') are the intended future extension.

---

### §34.3.1 — Virus-scanning deferral is now a documented risk acceptance (resolves the supplement-2 action)

- **Supplement-2 said:** §34.3.1 virus scanning is unimplemented; **Action:** ship a ClamAV sidecar OR document the deviation with a risk acceptance.
- **Reality (D-120, 2026-05-29):** The second option was taken. The deferral is formalized as a logged risk acceptance at `docs/runbooks/upload-virus-scanning-risk-acceptance.md`, scoped to the operator-only review surface (reviewers download attachments through the imports/review UI; no customer-facing download path).
- **Action for spec update:** §34.3.1 should NOT be edited to remove the ClamAV requirement; instead add `> **Status (2026-05-29):** Deferred — risk-accepted. See docs/runbooks/upload-virus-scanning-risk-acceptance.md and MEMORY D-120.` Vercel doesn't support sidecars, so the ClamAV path would need separate infra (Fly.io or similar) if the risk acceptance is ever revisited.

---

## No spec impact (recorded so a future sweep doesn't re-investigate)

- **D-123 — contracts-canary recorder** (PR #472): CI infrastructure. The contracts-canary mechanism is documented in `docs/testing/contract-tests.md`, not the tech spec. Operationally green pending two GitHub secrets (issue #473). No tech-spec text changes.
- **#481 — email-samples renderer + runbook** (`scripts/render-email-samples.tsx`, `docs/runbooks/email-samples.md`): a dev/review tool for visually inspecting email templates. Not a product surface; no spec impact.
- **D-118 — late import of D-106/D-107**: bookkeeping. The §23.4 scheduler split (D-107) and the §27.12 Anthropic Batches pipeline (D-106) are already documented at the tail of `reality-delta.md`.
- **D-119 — overnight open-issue sweep findings**: process decision (which backlog issues were autonomously completable). No spec impact.

---

## Process notes

Same conventions as the prior three delta docs:
- Append-only — do not edit prior entries without explicit approval.
- When a gap is closed, leave the entry with a `> **Closed YYYY-MM-DD in #PR**` callout.
- New deltas surfaced after this supplement belong in a future supplement-4, not edits to this file.

**Scope methodology this time:** this was NOT a full spec re-sweep (the last full read-every-line sweep was supplement-2, 2026-05-27). This supplement is narrower: it walks `MEMORY.md` D-118→D-124 and surfaces only the decisions that imply a spec edit. A future full sweep should still re-read the spec end-to-end.
