# Spec gap analysis — supplement #2 to reality-delta.md

Findings from a **read-every-line sweep** of `specs/TechSpec/section-*.html` against current `dev` branch state (2026-05-27). This is a second full sweep after the supplement's "Exhaustive spec sweep — overnight session 2026-05-26."

Entries here are gaps **NOT already documented in `reality-delta.md` or `reality-delta-supplement.md`**. The earlier sweep's findings stand; this supplement adds what that sweep missed.

Same conventions as the prior delta docs: append-only, `> **Closed YYYY-MM-DD in #PR**` on resolution.

---

## How this sweep differed

Two things found new gaps the prior sweep missed:

1. **Compared spec env-var names / file paths against current code** — surfaces drift from the Next 16 + monorepo rename work.
2. **Cross-checked spec invariants vs each spec's `<schema>` block** — surfaces internal spec inconsistencies that haven't been caught.

---

## Critical-path findings

### §15.12 — Sandbox mode partially implemented (only Stripe pause)
- **Spec:** Sandbox mode means: conversations flagged as test, bookings via fallback adapter, no commission records created, Stripe subscription paused, switching to live requires explicit confirmation.
- **Reality:** `apps/main/src/app/api/tenant/sandbox/route.ts` pauses/unpauses the Stripe subscription. The `is_sandbox` column on `tenants` is **never read anywhere else** in the codebase (verified via grep). Chat, bookings, and commission paths do not check `is_sandbox`. A tenant who flips sandbox=true still has real customer chats, real bookings via the real host adapter, and real commission records created.
- **Risk:** A tenant who believes they're in test mode will create real bookings + commissions. This was the entire safety promise of the mode.
- **Action:** Either (a) wire `is_sandbox` into the chat / bookings-submit / commissions paths to suppress real-money operations, or (b) update the spec to scope sandbox to "billing pause only" and rename.

### §34.3.1 — Virus scanning not implemented
- **Spec:** "Document upload and Gmail attachment paths MUST pass virus scanning before any parsing. Implementation: ClamAV daemon running as a sidecar service, or Supabase storage's native scan if available at build time. Files failing the scan are quarantined…"
- **Reality:** Zero matches for `virusScan`, `virus_scan`, `clamav` anywhere in `apps/main/src/`. The Gmail attachment + manual upload paths skip virus scanning entirely.
- **Risk:** Operator-facing reviewers download attachments through the imports/review UI; malicious attachments reach the operator's machine unscanned.
- **Action:** Either ship a ClamAV sidecar (Vercel doesn't support sidecars — would need a separate Fly.io or similar) OR document the deviation with a risk acceptance referencing the operator-only review surface.

### §11.3 / §25.3 — Customer self-service `/settings/memory` and `/settings/profile` pages missing
- **Spec §11.3:** "Customer can view, edit, and delete their memory at /settings/memory."
- **Spec §25.3:** "Right to correct — Self-edit in /settings/profile and /settings/memory."
- **Reality:** Neither route exists for customers. `docs/site-urls.md` lists only `/settings/price-watches` and `/settings/privacy` as customer pages. D-097 added a Memory tab to the in-chat sidebar; that's the only place a customer can view their memory. There's no standalone settings route.
- **Risk:** CCPA right-to-correct is technically claimed in the privacy policy but lacks the spec'd self-service surface. Customer would have to escalate to support.
- **Action:** Either build the two pages or update §25.3 to document the in-chat sidebar as the right-to-correct surface (still need a way for customers to edit profile fields like name/email).

### §18.5 / Greptile P1 #54 — First-use token TOCTOU still unfixed
- **Spec:** Token first-use binding to authenticated email (`token_first_used_at` + `token_bound_email`).
- **Reality (`apps/main/src/app/api/groups/invite/[token]/route.ts:118-122`):** `if (invitation.token_first_used_at === null) { ... update().eq("id", invitation_id) }`. **No CAS guard** — two concurrent first-use requests both pass the null check, both write, last write wins. Legitimate first-use caller can be locked out of their own invitation.
- **Status:** Listed in `docs/runbooks/audit-followups-2026-05-26.md` as round-2 P1 #54. Still open — neither the audit-followups doc nor reality-delta marks this as closed.
- **Action:** Add `.eq("token_first_used_at", null)` to the UPDATE and verify row count via `safeAwaitRowCount`.

### §18.10 — Group "sailed" read-only mode not enforced
- **Spec:** "At travel_start_date, group becomes IMMEDIATELY read-only for group details, RSVP, and member management. No edits, no new invitees."
- **Reality:** `apps/main/src/app/api/groups/[id]/` routes do not check `sailed_at` or `status='sailed'` anywhere. The `groups-mark-sailed.ts` cron sets the flag but POST/PATCH routes don't gate on it. (Same pattern as the supplement's §19.10 forum finding — but §19.10 was actually a misread; this §18.10 is a real gap because the spec text here genuinely says read-only.)
- **Action:** Add status check in groups/[id]/members POST, groups/[id]/route.ts PATCH, etc.

### §17.5 — Email blast on legal-doc version update missing
- **Spec:** Publish flow includes "Email blast to affected users with change summary."
- **Reality:** `/api/admin/legal-docs/route.ts` (lines 100-130) inserts pending consent rows but does **not** send any email. Users discover the new version only when they hit the consent gate on their next authenticated request. No proactive notification.
- **Risk:** Customers who don't actively use the platform won't see a Terms of Service update until they next sign in. CAN-SPAM-adjacent concern: notification of material terms changes is a customer-protection norm.
- **Action:** Add a `legalDocUpdateNotify` Inngest job dispatched on publish.

---

## Schema / spec internal inconsistencies

### §12.4 quotes schema — NUMERIC(12,2) money columns retained in spec text
- **Spec §12.4:** Schema shows `commissionable_fare NUMERIC(12,2)`, `total_amount NUMERIC(12,2)` etc.
- **Reality:** Migration `20260621000000_bp38_quote_options_expand.sql` added parallel `commissionable_fare_cents BIGINT`, `total_amount_cents BIGINT` columns. The legacy NUMERIC columns still exist; new code writes to `*_cents`. Both column sets are live.
- **Action for spec update:** Either drop NUMERIC from §12.4 (preferred — matches §14.0.1's "no NUMERIC money columns" doctrine) or document the parallel `*_cents` columns. The same migration that added the cents columns left the legacy ones in place per backward-compat — this is intentional dual-write.
- **Related:** reality-delta.md §6 documents `tier_definitions` schema additions but missed the parallel `quotes.*_cents` columns.

### §14.12 platform_revenue — spec text shows wrong NUMERIC precision
- **Spec §14.12:** `tier_rate_applied NUMERIC(5,2)`.
- **Spec §14.0.2:** "Rates and percentages are stored as `NUMERIC(5,4)` representing the decimal form."
- **Migration `20260525000000_money_columns.sql:73`:** `tier_rate_applied NUMERIC(5,4)` — and the migration's header comment explicitly calls out the spec deviation.
- **Action for spec update:** §14.12 should read `NUMERIC(5,4)` to match §14.0.2 and the live schema.

---

## Spec promises with no implementation

### §9.3 — Anthropic prompt caching declared but unwired
- **Spec:** "The full prompt is cached (Anthropic prompt caching) to reduce inference cost on subsequent turns."
- **Env var:** `ANTHROPIC_PROMPT_CACHE_ENABLED` declared in env.ts:198 with default `true`.
- **Reality:** Zero `cache_control` / `cacheControl` / `ephemeral` markers anywhere in `apps/main/src/lib/ai/`. The env var is read nowhere. AI calls go out without prompt-cache markers, so every turn pays full input-token cost on the system prompt.
- **Cost impact:** For a tenant on Sub-Host Agency tier ($249/mo) hitting the AI cost threshold, prompt caching typically reduces input-token cost 30-50% on multi-turn conversations. This is a real money lever that's off.
- **Action:** Wire `cache_control: { type: "ephemeral" }` markers in the system-prompt assembly, gated by `ANTHROPIC_PROMPT_CACHE_ENABLED`.

### §7.9 / §9.9 — SSE `Last-Event-ID` reconnect not implemented
- **Spec:** "Streaming: chat uses Server-Sent Events (SSE) with Last-Event-ID for reconnect." Also in §9.9: "Reconnect supported via Last-Event-ID header."
- **Reality:** `apps/main/src/app/api/chat/route.ts` streams SSE deltas but never emits `id:` lines per event and never reads the `Last-Event-ID` request header. EventSource's built-in auto-reconnect works at the connection level but **server-side resumption from the last delivered event is not supported** — a reconnect re-starts the stream from the beginning (which doesn't make sense for an LLM call that's already completed) or just times out.
- **Action:** Either implement server-side event IDs + `Last-Event-ID` header handling (significant work — needs server-side per-conversation event log), OR update the spec to say "EventSource auto-reconnect at the TCP/HTTP level; no application-level resumption."

### §7.9 — `Idempotency-Key` HTTP header not implemented for client mutations
- **Spec:** "Idempotency: critical mutations accept Idempotency-Key header (24-hour cache)."
- **Reality:** Grep for `Idempotency-Key`/`idempotency-key`/`idempotencyKey` finds only internal Stripe Connect transfers (server-side). No public HTTP route reads an `Idempotency-Key` request header. No 24-hour idempotency cache table.
- **Risk:** A retried `POST /api/bookings/[id]/submit` after a network timeout could double-submit (the bookings code has internal CAS guards per Greptile #51 — but that's CAS-status, not idempotency-key dedup).
- **Action:** Either build the idempotency middleware (requires a `request_idempotency` table + 24h cleanup cron) or drop the claim from spec §7.9.

### §24.7 — Chat draft persistence not implemented
- **Spec:** "Messages saved as user types (draft) and on submit (final)."
- **Reality:** No draft-saving mechanism exists in the chat surface. Grep for `saveDraft`/`message.*draft`/`draft.*messages` in `apps/main/src/components/chat/` returns zero matches. If the user closes the tab mid-typing, their in-progress text is lost.
- **Action:** Either build draft autosave (localStorage-backed is fine for a customer-facing chat; no server roundtrip needed) or drop the claim from §24.7.

### §10.6 — Per-tenant AI kill switch not implemented
- **Spec §10.6:** "platform admin can pause AI responses globally or per-tenant."
- **Reality:** Only the global kill switch (`platform_settings.ai_kill_switch_engaged`) is wired (per the recent D-091 R3 #43 fix). No per-tenant kill switch table or column.
- **Note:** `tenants.ai_mode='disabled'` is the operational near-equivalent at the tenant level, but it's **tenant-controlled** (set via tenant admin UI), not **platform-admin-controlled**. A platform admin who needs to pause AI for one misbehaving tenant has no spec'd lever.
- **Action:** Either add a `platform_tenant_overrides.ai_paused_by_platform` column (small change) or update §10.6 to say "globally only; per-tenant via the tenant's own `ai_mode` setting."

---

## Documented runtime deviations not yet in reality-delta.md

These are real deviations from the spec text, with an in-code comment explaining the choice, but missing from `reality-delta.md §4 (Runtime decisions)`.

### Next.js version: spec says 14, reality is 16
- **Spec §1.2 / §2.1 / §29.2:** "Next.js 14 (App Router)" / "Next.js 14".
- **Reality:** Next.js 16 across the monorepo. Forced by upstream upgrade; surfaced the `middleware.ts → proxy.ts` rename (PR #323) and the instrumentation timing cascade ([[D-101]]).
- **Action for spec update:** Add to reality-delta.md §4 alongside Node.js 24 LTS.

### `middleware.ts` → `proxy.ts` file rename (Next 16 deprecation)
- **Spec §1.4 / §3.6 code excerpts:** Reference `apps/main/src/middleware.ts`.
- **Reality (PR #323):** File is `apps/main/src/proxy.ts`. Function `tenantResolverMiddleware` → `tenantResolverProxy`. Test file + stryker config + one comment path-reference also updated.
- **Action for spec update:** Both code excerpts in §1.4 and §3.6 should reference proxy.ts.

### `SERVICE_JWT_*` env var names (spec says `INTER_SERVICE_JWT_*`)
- **Spec §28.4:** `INTER_SERVICE_JWT_PRIVATE_KEY`, `INTER_SERVICE_JWT_PUBLIC_KEY`, `INTER_SERVICE_JWT_KEY_ID`, `INTER_SERVICE_JWT_TTL_SECONDS`, `INTER_SERVICE_JTI_CACHE_URL`.
- **Reality (`apps/main/src/lib/env.ts:70-74`):** `SERVICE_JWT_PRIVATE_KEY`, `SERVICE_JWT_KEY_ID`, `SERVICE_JWT_TTL_SECONDS`. JTI cache uses generic `REDIS_URL`. Rotation overlap done via `SERVICE_JWT_ACCEPTED_KEY_IDS` (comma-separated allowlist) rather than `_PUBLIC_KEY_PREVIOUS`.
- **Status:** Tracked in `docs/env-audit.md` with a "scope flag" recommending the rename touches RAG + GitHub Actions + Vercel env, so the user should be brought in before acting.
- **Action for spec update:** Either accept the code naming (drop `INTER_` prefix from spec §28.4) or schedule the rename as a coordinated env migration.

### `RAG_SERVICE_URL` env var (spec says `PLATFORM_RAG_SUBDOMAIN`)
- **Spec §28.1:** `PLATFORM_RAG_SUBDOMAIN` — required.
- **Reality:** Code uses `RAG_SERVICE_URL` (full URL, not subdomain). Equivalent surface; different shape.
- **Tracked in:** `docs/env-audit.md`.
- **Action for spec update:** Reconcile.

### `PLATFORM_TENANT_SUBDOMAIN_BASE` — missing entirely
- **Spec §28.1:** Required env var.
- **Reality:** Doesn't exist. Code derives tenant subdomains from `PLATFORM_DOMAIN_REGEX` against `PLATFORM_PRIMARY_DOMAIN` instead.
- **Tracked in:** `docs/env-audit.md`.
- **Action for spec update:** Document the regex-based equivalence in §28.1 or schedule adding the var.

### §15.13 — 180-day auto-suspend deliberately skipped for paying tenants
- **Spec §15.13:** "auto-downgrade or suspend at 180 days inactivity."
- **Reality (`apps/main/src/inngest/compliance-nightly.ts:14-20` + `:228-233`):** Comment explicitly says "No 180-day auto-suspend for inactive PAYING tenants. The user's framing: paying customers shouldn't lose access because they're not using the app. The 180d level row stays in NUDGE_LEVELS as a final reminder; the suspend branch is gone." Referenced as a deliberate policy change from PR #121.
- **Action for spec update:** §15.13 should add `> **Status:** 180-day auto-suspend deliberately disabled for paying tenants per PR #121. The 180d level is a log breadcrumb only — no email, no suspension. Non-paying past-grace tenants handled via middleware redirect + separate cron, not this branch.`

---

## Documentation accuracy fix needed

### Supplement misread §19.10 — actually not a gap
- **Supplement claim:** "§19.10 — Post-sailing forum read-only mode (MISSING). Spec: Once a group's sailing_date passes, the group's forum transitions to read-only…"
- **Actual spec §19.10:** "Forum stays fully active for in-trip and post-trip conversation. Coordinator can post updates, photos, post-trip thanks. AI screening continues. **No automatic forum closure** — coordinator can manually lock when group has run its course."
- **The supplement's "gap" is not a gap.** The spec doesn't require auto-closure of the forum. The supplement appears to have conflated §18.10 (group details read-only on sailing — which IS a real gap, see above) with §19.10 (forum stays open — by design).
- **Action:** Strike the §19.10 entry from `reality-delta-supplement.md` or annotate it as "not actually a gap; spec was misread."

---

## Audit-followups not yet closed (cross-reference summary)

Items from `docs/runbooks/audit-followups-2026-05-26.md` that I verified are still open in current code:

- **P1 #7** — RAG JWT: all kids map to same PEM (`apps/rag/src/lib/auth/verify-service-jwt.ts:55-63`). Zero-downtime key rotation impossible.
- **P2 #13** — CCPA purge gap: `conversations.user_id` never cleared on customer deletion. (Contacts.notes nulling IS fixed.)
- **Round-2 #54** — First-use token TOCTOU (see §18.5 above).

Items I verified ARE closed but not marked in audit-followups:

- **Round-3 #43** — Chat kill switch in streaming mode. Code at `apps/main/src/app/api/chat/route.ts:543-565` checks the kill switch **before** acquiring the stream. The d091 addendum (2026-05-27) said this was "still pending implementation as of this addendum" — should be marked closed.
- **Round-3 #47** — Quote price-lock expiry enforcement. `apps/main/src/app/api/quotes/[id]/accept/route.ts:83-89` checks `price_lock_expires_at` and rejects on expiry.

---

## Confirmed present (spot-checks during this sweep)

For completeness — items I checked during this re-sweep that are properly wired (in addition to the supplement's TICK list):

- §6.10 feedback knobs sync to RAG via `apps/main/src/lib/rag-sync/publish-platform-event.ts` (all 4 keys)
- §8.7a `pending_rag_sync` table + `source_revision` column (RAG migration 0007)
- §10.1a regen budget columns (`regen_tokens_consumed`, `regen_count_total`, `regen_budget_exhausted_at`) + env caps
- §9.10.3 `background_ai_enabled` column + tenant UI toggle
- §13.5 boot-time validation of `APP_ENCRYPTION_KEY_CURRENT` to 32 bytes + `FORENSICS_ENCRYPTION_KEY_CURRENT` distinctness check
- §13.5 `re-encrypt-old-records` Inngest job
- §13.5.3 `APP_ENCRYPTION_BACKUP_VERIFIED_AT` env var + quarterly cadence in secret-rotation runbook
- §14.0.4 money-math lint rule (`packages/config/eslint-rules/no-money-math.js`)
- §17.7 sensitive-action re-auth (`/auth/reauth` page + assertPermission integration)
- §19.3 forum moderation pending_moderation + retry sweep
- §19.9 forum strike system (`apps/main/src/lib/forums/strikes.ts`)
- §21.10.1 quote variance + `pending_customer_reconfirmation` booking status + per-tenant `quote_variance_cents` override
- §22.1 browser extension + iOS Shortcut submission endpoints
- §24.8 anonymous chat 3-identifier limit (session/IP/fingerprint)
- §30.8 cross-tenant probe + cross-tenant Inngest probe both exist

---

## Process notes

Same conventions as the prior two delta docs:
- Append-only — do not edit prior entries without explicit approval.
- When a gap is closed, leave the entry with a `> **Closed YYYY-MM-DD in #PR**` callout.
- New gaps surfaced after this sweep belong in a future supplement-3, not edits to this file.

**Sweep methodology this time around:**
1. Read every subsection of every spec file (40 sections + d091 addendum, ~600 KB).
2. For each spec claim, grep the code (not relying on prior sweeps).
3. Cross-checked spec internal consistency (§12.4 vs §14.0.1; §14.12 vs §14.0.2; §1.5 vs §4 feature matrix).
4. Compared spec env var names to `apps/main/src/lib/env.ts` exhaustively.
5. Checked the supplement's claims against current spec text (caught the §19.10 misread).

Total new findings: ~20. Most are documentation-accuracy items (spec text drift); ~5 are real implementation gaps with customer / money / compliance impact (sandbox mode, virus scanning, customer settings pages, TOCTOU lock, group sailed read-only).
