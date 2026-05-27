# Audit follow-ups — 2026-05-26 (D-091 / Greptile review)

Findings from Greptile's audit of **10 high-risk subsystems** (two rounds) plus a grep-based sweep of the rest of the codebase using the same pattern templates. Round 1 covered auth, crypto, Stripe, Apify, RAG. Round 2 covered Inngest crons, tenant routes, forums routes, host-adapters + email, onboarding + consent.

## P1 — fix before launch

| # | File:Line | Issue | Status |
|---|---|---|---|
| 1 | `apps/main/src/lib/stripe/webhook-handler.ts` (7 sites) | Every `db.update().eq()` result is unchecked — silent DB failures report 200 to Stripe, suppressing retries | open |
| 2 | `apps/main/src/lib/pricing/apify-pricing-adapter.ts:226-228` + `cruisemapper-actor.ts:102` | Apify token in URL query string — visible in proxy/CDN/APM logs | open |
| 3 | `apps/main/src/lib/pricing/apify-pricing-adapter.ts:104-127` | Monthly budget gate checked once per multi-batch run, not per batch — concurrent runs both pass | open |
| 4 | `apps/main/src/lib/pricing/apify-pricing-adapter.ts:149` | `estimated_skipped` rows write phantom spend that inflates the monthly cap | open |
| 5 | `apps/main/src/lib/crypto/credential-cipher.ts:35-91` | GCM AAD not bound to `key_id` — DB-write attacker can mutate key_id | open |
| 6 | `apps/rag/src/app/api/feedback/route.ts:93-98` | HMAC-only auth has no tenant scope — cross-tenant ranking manipulation via shared secret | open |
| 7 | `apps/rag/src/lib/auth/verify-service-jwt.ts` | All kids map to same PEM — zero-downtime JWT key rotation impossible | open |

## P2 — schedule for the next maintenance window

| # | File | Issue |
|---|---|---|
| 8 | `apps/main/src/lib/db/platform-admin-client.ts:167-169` | Nested `withPlatformAdminAudit` skips reason_detail friction check + misattributes audit |
| 9 | `apps/main/src/lib/auth/assert-permission.ts:156-159` | `getConsentPending` fires before tenant membership check — leaks consent status to non-members |
| 10 | `apps/main/src/lib/auth/assert-platform-admin.ts:28`, `apps/main/src/lib/db/factories.ts:150/213` | Service-role imports missing ESLint exemption — lint boundary has silent gaps |
| 11 | `apps/main/src/lib/privacy/customer-hash.ts:25-26` | String concat + SHA-256 instead of HMAC-SHA256 (spec §25.4 says HMAC). Migration cost: re-derive every existing hash |
| 12 | `apps/main/src/lib/crypto/credential-cipher.ts:31-33` | `getKeyBuffer` doesn't validate decoded length is 32 bytes |
| 13 | `apps/main/src/lib/privacy/purge-user-data.ts` | CCPA gaps: contacts with NULL notes retain user_id; conversations.user_id never cleared |
| 14 | `apps/main/src/lib/forensics/decrypt.ts` | Access counter non-atomic read-modify-write — undercounts under concurrent access (legally-sensitive audit trail) |
| 15 | `apps/main/src/lib/stripe/webhook-handler.ts:278-281` | No refund or dispute event handlers — commission ledger diverges from cash flows |
| 16 | `apps/main/src/lib/stripe/webhook-handler.ts:161-170` | Dead `else if (Object.keys(updates).length > 0)` branch |
| 17 | `apps/main/src/lib/stripe/webhook-handler.ts:49-53` | Missing `stripe-signature` header passed as empty string |
| 18 | `apps/main/src/app/api/onboarding/subscription/checkout/route.ts` | Success/cancel URLs use `NEXT_PUBLIC_SUPABASE_URL` instead of app URL — customers redirected to Supabase API domain |
| 19 | `apps/main/src/lib/pricing/apify-pricing-adapter.ts:164-166` | Dead-code ternary — timeouts indistinguishable from network errors in ledger |
| 20 | `apps/rag/src/app/api/feedback/route.ts:41-48` | Custom JS `timingSafeEqual` — use `node:crypto` native |
| 21 | `apps/rag/src/app/api/feedback/route.ts:61-67` | Rate-limit fails open on Redis outage — defense-in-depth silently disabled |
| 22 | `apps/rag/src/app/api/retrieve/route.ts:107-128` | `rag_media_assets` service-role query has no DB-level tenant filter |
| 23 | `apps/rag/src/app/api/retrieve/route.ts:144-147` | `tenant_id` field in response may leak ingester identity for global chunks |

## Codebase-wide grep sweep (same patterns applied broadly)

### Unchecked Supabase mutations — ~113 sites

The Stripe-webhook pattern (`await db.from(...).update(...).eq(...)` with discarded result) appears across the codebase. Sample sites:

```
apps/main/src/app/api/forums/messages/[id]/route.ts:51,65,79,92
apps/main/src/app/api/forums/[forumId]/route.ts:36
apps/main/src/app/api/forums/[forumId]/threads/[threadId]/messages/route.ts:250,281
apps/main/src/app/api/forums/threads/[id]/route.ts:50
apps/main/src/app/api/forums/users/[userId]/state/route.ts:43,56
apps/main/src/app/api/tenant/chat-limits/route.ts:141
apps/main/src/app/api/tenant/billing/route.ts:136,158,183,202
...
```

**Recommended remediation**: Ship `atc/no-unchecked-supabase-mutation` ESLint rule (this PR). Initial setting `warn` so the existing sites surface without blocking merges. Operator decides which to fix in the next two-week cleanup pass.

Not all 113 are real defects — some are intentional (best-effort writes where the caller doesn't need to know if it succeeded). Each call site needs a 30-second review.

### Fail-open `{ allowed: true }` returns — 10 sites

```
apps/main/src/lib/chat/anonymous-limit.ts:101
apps/main/src/lib/abuse/help-submission-rate.ts:99,117 (allowed returns on the "ok" path — legitimate)
apps/main/src/lib/email/rate-limit.ts:33,53,71,74 (4 returns, need review)
apps/main/src/lib/external/cruisemapper/image-asset-recorder.ts:66
apps/rag/src/lib/rate-limit/feedback-limit.ts:48 (Greptile flag — Redis-down fail-open)
```

Most are the "allowed on the ok path" pattern (legitimate). The two real problem cases:
- `rag/.../feedback-limit.ts:48` — already flagged by Greptile (P2 #21)
- `email/rate-limit.ts` — needs review on whether the 4 fail-open returns are intended

**Recommended remediation**: case-by-case review of the 5 ambiguous sites. No lint rule (heuristic too false-positive-prone).

### Credentials in URL — 2 outbound calls (both Greptile-flagged), 2 customer-channel URLs (safe)

Refined grep found 5 matches:

```
apps/main/src/app/api/email/unsubscribe/route.ts:2      ← route doc comment (FP)
apps/main/src/inngest/precruise-generate-and-send.ts:176 ← customer unsubscribe link (intended channel)
apps/main/src/lib/tasks/send-reminder-email.ts:96       ← customer unsubscribe link (intended channel)
apps/main/src/lib/external/cruisemapper/cruisemapper-actor.ts:102 ← OUTBOUND Apify call (Greptile P1)
apps/main/src/lib/pricing/apify-pricing-adapter.ts:226  ← OUTBOUND Apify call (Greptile P1)
```

**Real findings: only the 2 Greptile already flagged.** The unsubscribe URLs are customer-facing one-time signed-token channels — token IS the credential, intended URL channel, sent in email body not over fetch.

The new `atc/no-credentials-in-url` ESLint rule correctly distinguishes these — it only fires on `fetch()` call-sites, not on URL construction for email bodies.

**Remediation**: fix the 2 Apify sites per Greptile P1 #2 (move token to `Authorization: Bearer` header). Rule prevents recurrence.

### Service-role usage — existing rule already has comprehensive allowlist

139 sites import `createServiceRoleClient` across the codebase. The existing `atc/no-direct-service-role-import` rule uses a **path-suffix allowlist** (`ALLOWED_PATH_SUFFIXES` in `packages/config/eslint-rules/no-direct-service-role-import.js`) with ~150 documented entries — every Inngest cron, webhook handler, admin endpoint, cross-tenant scan, etc. Each entry has a one-line comment explaining why service-role is required.

Greptile's finding "`assert-platform-admin.ts` and `factories.ts` import service-role without an `// eslint-disable` exemption comment" describes the WRONG mechanism — the rule uses an allowlist, not inline disable comments. Both files ARE governed by the rule's allowlist (assert-platform-admin.ts is explicitly listed; factories.ts is the more interesting case worth a closer look).

**Real audit-worthy concern**: ensure every NEW service-role caller gets added to the allowlist with a justification comment. The rule itself is the enforcement; the comment is the trail.

**Remediation**: no codebase change needed. Discipline carried forward via the rule.

### Tenant_id leak in responses — 0 cross-tenant leaks, 2 minor over-exposure cases

Refined grep found these spread patterns:

```
apps/main/src/app/api/forums/[forumId]/threads/[threadId]/messages/route.ts:261, 303
   return Response.json({ ...msg, ... })    ← spreads forum_messages row (includes tenant_id)

apps/main/src/app/api/admin/legal-docs/route.ts:181
   return Response.json({ ok: true, ...result })          ← admin (cross-tenant intended)
apps/main/src/app/api/admin/tenants/review-queue/route.ts:46
   return Response.json({ ...result, page, ... })          ← admin (cross-tenant intended)
apps/main/src/app/api/admin/tenants/[id]/custom-domain/route.ts:142
   return Response.json({ ok: true, ...result })          ← admin (cross-tenant intended)
```

The 3 admin routes are intentional (platform admins see cross-tenant). The 2 forum routes spread `msg` (a `forum_messages` row) — the response goes to an authenticated tenant user who already knows their own tenant_id, so this is NOT a cross-tenant leak. The risk is **unnecessary attack surface** — fields like `created_by_internal_id` or `moderation_scores_raw` get exposed when they shouldn't be in the public response shape.

**Real findings: 0 cross-tenant leaks. 2 minor over-exposure cases** in forum routes worth tightening to explicit field selection.

**Remediation**: refactor the 2 forum routes to return explicit field selection. Low priority. Note: the Greptile finding (PR #238 P2 #23) was about `/api/retrieve` returning `tenant_id` for global-scope chunks — that's the higher-impact case and is on the P2 punch list above.

## Round 2 — additional Greptile findings (5 more subsystems)

After D-091 anti-pattern infrastructure landed, 5 new Greptile audits ran on the next-tier high-risk surfaces. Confidence scores: 1/5 (tenant billing) and 2/5 (everything else).

### Round 2 — P1 / money + security

| # | File:Line | Issue | Notes |
|---|---|---|---|
| 24 | `apps/main/src/inngest/payouts-execute-transfer.ts` | **CAS lock guard non-functional.** `.update().eq("status", "available")` returns `error: null` on zero-row update (Supabase quirk). Two concurrent runs can both "acquire the lock" and double-process the payout | New pattern; ESLint can't catch — code-review rule |
| 25 | `apps/main/src/inngest/payouts-execute-transfer.ts` | `stripe_transfer_id` write after Stripe success is unchecked — Pattern 1 in money path | Same as #1 Pattern 1 |
| 26 | `apps/main/src/inngest/payouts-reconcile-processing.ts` | 60-second race-avoidance buffer uses `created_at` not a `processing_started_at` — reconcile can fire before in-flight Stripe call returns | Timing logic bug |
| 27 | `apps/main/src/inngest/payouts-reconcile-processing.ts` | Stripe transfer-list `limit=10` — high-volume Connect accounts miss idempotency hits and recreate already-paid transfers | Pagination bug |
| 28 | `apps/main/src/inngest/commission-split-on-received.ts` | `platform_revenue` insert unchecked — silent failure orphans the revenue row, commission ledger diverges from cash flows | Pattern 1 |
| 29 | `apps/main/src/inngest/payouts-mark-available.ts` | Bulk mark-available update lacks `status='pending'` guard — overwrites out-of-band manual status changes | CAS-style guard missing |
| 30 | `apps/main/src/inngest/abuse-recompute-nightly.ts` | All 4 `checkStateTransitionIfNeeded` calls are `void`-prefixed — state-machine enforcement is fire-and-forget; cron reports success even when nothing fired | New pattern: void-prefixed-async |
| 31 | `apps/main/src/app/api/tenant/billing/route.ts` (lines 137, 159, 184, 203) | 4 unchecked `tenantClient.update()` sites in customer-facing billing flow. Stripe mutated first; silent DB failure returns `{ok:true}` to user while Stripe and DB are permanently inconsistent | Pattern 1 (highest-impact instance) |
| 32 | `apps/main/src/app/api/tenant/billing/route.ts` | Reducing seats to 1 never updates Stripe — orphaned `additional_seats` line item continues overbilling the customer | Real-money bug |
| 33 | `apps/main/src/app/api/tenant/billing/route.ts` | Monthly→annual transition only swaps base price; seat items stay on monthly pricing | Real-money bug |
| 34 | `apps/main/src/app/api/forums/messages/[id]/route.ts` | All 4 mutation queries use service-role with NO `tenant_id` filter | Pattern 5 confirmed |
| 35 | `apps/main/src/app/api/forums/messages/[id]/route.ts` | `assertPermission("forums", "edit_message")` covers both self-edit AND coordinator moderation — wrong-role users can do operations they shouldn't | New pattern: wrong-action-gate |
| 36 | `apps/main/src/app/api/forums/messages/[id]/route.ts` | `userPerms.role` hardcoded to `"member"` — `tenant_owner` non-coordinators incorrectly blocked from valid moderation | Hardcoded role drift |
| 37 | `apps/main/src/lib/host-adapters/select-adapter.ts` | Sub-host branch (Step 2) returns `credentials: null` — every sub-host adapter call runs with NO tenant-specific credentials | Stub-shaped code (Pattern from D-091) |
| 38 | `apps/main/src/app/api/webhooks/resend/route.ts` | Svix signature decoded as hex; Svix uses base64url — **silently rejects every real bounce/complaint webhook.** Hard-bounce suppression currently inoperative | New pattern: signature encoding mismatch |
| 39 | `apps/main/src/lib/onboarding/state-machine.ts` (`progressTo`) | **TOCTOU race.** UPDATE predicate filters on `tenantId` only, not current stage. Concurrent webhook + admin advance regresses tenant to earlier stage | Pattern 6 confirmed |
| 40 | `apps/main/src/lib/onboarding/state-machine.ts` (`revertTo`) | Accepts target stage from untrusted JSON without checking it's a backwards transition — admin "request more info" can be called with `target: "complete"` to bypass review | Untrusted-input-to-state-machine |
| 41 | `apps/main/src/lib/stripe/webhook-handler.ts` | Idempotency row written BEFORE dispatch — first-delivery crash after metadata write but before `progressTo` permanently strands tenant mid-stage (Stripe retries rejected as duplicate) | Idempotency-stranding |

### Round 2 — new patterns added to the catalog

These should be added to `docs/runbooks/anti-patterns.md` in a follow-up:

7. **Zero-row update returns `error: null`.** Supabase JS does NOT distinguish "matched zero rows" from "succeeded." Every CAS-style lock using `.update().eq("status", "X")` has this bug. Cannot be ESLint-caught.
8. **`void`-prefixed async** treated as fire-and-forget when the call's return value carries enforcement signal.
9. **Wrong assertPermission action** for multi-operation routes (one action gate covers two semantically-different operations).
10. **Idempotency-row-before-dispatch.** Writing the dedup row before completing the operation creates a stranded-state failure mode.
11. **Untrusted input flowing into state-machine actions** with no validation of transition direction or target validity.
12. **Webhook signature encoding mismatch** (e.g. hex vs base64url) — silently rejects all valid webhooks, defense-in-depth becomes attack vector by making downstream enforcement (suppression list) inoperative.

### Round 2 — highest-business-impact issues

| Severity | Issue (round-2 #) | Why it matters |
|---|---|---|
| **Real money** | #24 Payout CAS lock | Could double-process payouts (real money out the door twice) |
| **Real money** | #31-#33 Tenant billing | Stripe/DB divergence; orphaned line items overbilling customers |
| **Compliance** | #38 Resend signature mismatch | Bounce/complaint webhooks silently failing → CAN-SPAM exposure (re-sending to known-bouncers) |
| **Security** | #40 `revertTo` accepts untrusted target | Bypasses admin review gate |
| **Data integrity** | #39 `progressTo` TOCTOU | Stage regression under concurrent updates |

## Patterns identified — preventive infrastructure

See `docs/runbooks/anti-patterns.md` for the consolidated pattern catalog (6 original patterns + 6 round-2 patterns, the latter to be appended in a follow-up) and the ESLint rules / CLAUDE.md doctrine added to prevent recurrence.

## Summary statistics (rounds 1 + 2; cross-round totals after round 3 are at the end of the document)

- **10 Greptile audits** run in rounds 1+2 (5 each)
- **~40 actionable findings**, ~7 P1 from round 1 + ~10 P1-equivalent from round 2
- **6 original patterns** + 6 new round-2 patterns = 12 recurring patterns identified
- **3 ESLint rules** shipped + **7 CLAUDE.md doctrine additions** + **slop-check workflow** + **error-injection probe design doc** = preventive infrastructure in place
- ~113 grep-found instances of Pattern 1 (unchecked Supabase mutations) across the codebase, confirmed widespread

_Round 3 added 10 more audits, 18 more findings, and 6 more patterns — see the "Round 3 — additional Greptile findings" section above and the "Cross-round totals" table at the end. Latest figures: **15 audits / ~90 findings / 18 patterns**._


---

## Round 3 — additional Greptile findings (10 more subsystems)

After Tier-1 fixes were drafted, 10 more Greptile audits ran on the next-tier high-risk surfaces. Confidence scores ranged from 1/5 (quotes) to 3/5 (imports, DNS). Every single audit found Pattern 1 (unchecked Supabase mutation) — confirming it's the dominant codebase-wide pattern.

### Round 3 — P1 / highest impact

| # | File:Line | Issue | Notes |
|---|---|---|---|
| 42 | `apps/main/src/app/api/chat/route.ts` | **Conversation history absent from every LLM call.** `messages: [{ role: 'user', content: userMessage }]` is single-turn; customers think they're chatting but each turn is stateless | Product correctness, not just a bug |
| 43 | `apps/main/src/app/api/chat/route.ts` | **Kill switch gap in streaming mode.** `runSupervisor` (which checks `ai_kill_switch_state.global_paused`) runs AFTER all sentence deltas flushed → kill switch silently bypassed when streaming | §28.15 invariant violated |
| 44 | `apps/main/src/lib/rag-ingest/haiku-pii-redact.ts` | **Haiku PII redact fails OPEN.** Missing API key OR Haiku error returns the original unredacted content with `status: 'clean'` → PII flows into RAG | §22.4 fail-closed contract violated |
| 45 | `apps/main/src/inngest/user-data-purge-after-grace.ts` | **CCPA purge silently skips multi-tenant users.** Query by `auth_user_id` only with `maybeSingle()` returns null (not error) on multi-row match. Any user enrolled in 2+ tenants has right-to-erasure dropped | Compliance violation in waiting |
| 46 | `apps/main/src/inngest/user-data-export-build.ts` | `select('*')` leaks `tenant_id` + internal columns into user-downloadable bundle | CCPA scope leak |
| 47 | `apps/main/src/app/api/quotes/[id]/accept/route.ts` | **Confirmed-quote expiry never checked.** `price_lock_expires_at` read into audit snapshot but never compared with `new Date()` → customers can accept stale price locks | Real money — contractually bound to honor |
| 48 | `apps/main/src/app/api/quotes/[id]/accept/route.ts` | **Dispute-defense PDF discarded.** §21.10.1 says the rendered HTML "is the document that wins arbitrations." Code computes it then stores only the hash. Audit toothless | Legal liability |
| 49 | `apps/main/src/app/api/quotes/[id]/accept/route.ts` | Race: no `.in("status", ["sent","viewed"])` CAS guard on UPDATE → concurrent acceptances both pass status check, second overwrites `customer_accepted_audit_id` | Pattern 7 |
| 50 | `apps/main/src/app/api/bookings/[id]/submit/route.ts` | **Non-atomic host submit.** `adapter.submitBooking()` runs BEFORE commissions insert + status transition. If commissions write fails: host has booking confirmed, our DB shows draft + no provider_booking_ref → client retry re-submits | Pattern 10 variant — real-money |
| 51 | `apps/main/src/app/api/bookings/[id]/submit/route.ts` | Draft-status check has no CAS guard → concurrent submits both pass, both call adapter, both write `submitted` | Pattern 7 |
| 52 | `apps/main/src/app/api/admin/reconciliation/upload/route.ts` | **Audit-wrapper callback signature wrong.** `withPlatformAdminAudit(opts, async () => {...})` declared with no params → `db` + `recordQuery` args dropped → every audit row for reconciliation uploads has empty `queries` array | New pattern — broken signature |
| 53 | `apps/main/src/app/api/admin/reconciliation/upload/route.ts` | **Prompt injection.** Raw CSV text interpolated verbatim into Haiku user-turn → crafted booking-ref like `Ignore previous instructions...` alters auto-accept decisions | New pattern — LLM prompt injection |
| 54 | `apps/main/src/app/api/groups/invite/[token]/route.ts` | First-use token binding TOCTOU. Two concurrent GETs both see `token_first_used_at = null`, both write, last writer wins → legitimate first-use caller locked out forever | Pattern 6 variant |
| 55 | `apps/main/src/app/api/groups/invite/[token]/route.ts` | PATCH returns `{ ok: true }` when zero rows updated → false confidence on revoked/missing invitation | Pattern 7 variant |
| 56 | `apps/main/src/lib/ai/call-wrapper.ts` | **`instrumentedClaudeCall` doesn't fail-closed on `hard` state.** Snapshot loaded + state visible, wrapper proceeds anyway → delegates hard-block to call sites that may forget | §27.6 enforcement gap |
| 57 | `apps/main/src/lib/ai/call-wrapper.ts` | `tenant_usage_metrics` read-then-write counter has no atomicity → concurrent serverless calls systematically undercount spend | Pattern 6 variant — money tracking |
| 58 | `apps/main/src/lib/ai/call-wrapper.ts` | **`instrumentedOpenAIEmbedding` bypasses ALL enforcement.** Never loads tenant snapshot → hard-state tenants are still served + embedding spend never triggers state machine | §27.6 gap — second AI path |
| 59 | `apps/main/src/inngest/import-pipeline.ts` | Orphaned row on Inngest dispatch failure. Import row inserted before `inngest.send`; if send throws, row is stuck at `pending_classification` with no reconciliation cron | Pattern 10 variant |

### Round 3 — P2

Each subsystem has Pattern 1 mutations (15-20+ more unchecked Supabase mutations across all 10 audits). Documented but not enumerated here — covered by the existing `atc/no-unchecked-supabase-mutation` rule once codebase-wide cleanup pass lands.

### Round 3 — new patterns added to the catalog

13. **Stateless LLM call** (variant of Pattern 8): the LLM call passes only the current message instead of conversation history. Symptom: customers think the AI "forgot" prior turns.
14. **Kill switch gap in streaming**: a runtime kill switch is checked AFTER the user-visible action completes. The switch becomes a post-hoc audit, not an enforcement.
15. **LLM prompt injection via raw user input**: untrusted strings interpolated into the user-turn content of an LLM call. Mitigation: use tool-call/JSON mode, OR escape, OR move untrusted content to a separate stratum the prompt explicitly says to treat as data.
16. **Broken audit-wrapper callback signature**: a higher-order audit wrapper passes `(db, recordQuery)` to its inner function, but the inner function ignores these args and uses an outer-scope client → wrapper's audit trail is empty.
17. **`select('*')` in user-facing data export**: leaks internal columns (tenant_id, audit fields, new columns added by future migrations) to user-downloadable bundles.
18. **`maybeSingle()` masks multi-row matches**: returns `null` on either zero OR multiple matches, silently skipping records when the query needs an iterator instead.

### Round 3 — recommended Tier-1 additions

Quick-win fixes after the original Tier-1 lands. Each ≤ 1h, all close real risk. Numbered references map to the P1/high-impact table above.

- **#42 Chat conversation history** — highest product impact
- **#43 Chat kill switch in streaming mode**
- **#44 Haiku PII redact fail-closed**
- **#45 CCPA multi-tenant purge fix** (iterate instead of `maybeSingle`)
- **#46 CCPA export explicit column allowlist**
- **#47 Quote price-lock expiry enforcement**
- **#48 Quote dispute PDF actually persisted** to audit_log
- **#49 Quote acceptance CAS guard** (`.in("status", ["sent","viewed"])` + row-count) — prevents stranded audit rows from concurrent acceptance
- **#50 Bookings non-atomic host submit** — order operations so commission row is written BEFORE the host adapter call, OR add a reconciliation cron for orphaned bookings
- **#51 Bookings draft-status CAS guard** — concurrent submit double-call prevention
- **#52 Admin reconciliation audit-wrapper signature** — accept `(db, recordQuery)`
- **#53 Admin reconciliation Haiku prompt-injection mitigation** — use tool-call/JSON mode OR explicit delimiter + system-prompt warning
- **#56 `instrumentedClaudeCall` doesn't fail-closed on `hard` state** — same §27.6 enforcement gap as #58, same file. Wire hard-state refusal at the wrapper level instead of delegating to call sites that may forget.
- **#58 OpenAI embedding path bypasses all enforcement** — wire `loadTenantSnapshot` + state-machine check, mirroring the Claude path

(Greptile noted findings #50, #51, #56, #58 were P1-flagged but missing from the original quick-wins list. Added explicitly so they're not silently deprioritized. #56 + #58 should ship together — they're the same `call-wrapper.ts` change.)

## Cross-round totals (after 15 audits, ~90 findings)

| Pattern | Audits flagged | Status |
|---|---|---|
| 1. Unchecked Supabase mutation | 15/15 | `atc/no-unchecked-supabase-mutation` rule ready; ~113+ sites; codebase-wide cleanup is the structural fix |
| 5. App-layer-only tenant scoping | 10/15 | Doctrine + grep audit done |
| 7. Zero-row CAS update | 6/15 | Doctrine added; ~5 confirmed sites |
| 8. void async / stateless LLM | 5/15 | Doctrine added; LLM-statelessness is the variant worth fixing |
| 6. TOCTOU race | 7/15 | Doctrine added; in flight (state-machine fix in PR #259) |
| 2. Fail-open on resource error | 4/15 | Doctrine added; Haiku PII fail-open is the highest-impact uncovered case |
| 9. Wrong assertPermission action | 1/15 | Doctrine added (round 2); forums route fix not yet shipped |
| 10. Idempotency-before-dispatch | 2/15 | Doctrine added; Stripe + imports both have the pattern |
| 11. Untrusted state-machine input | 1/15 | Fixed (PR #259) |
| 12. Webhook signature encoding | 1/15 | Fixed (PR #258) |
| 13. Stateless LLM call (round 3) | 1/15 found by Greptile (chat); grep found 1 more (help-AI) | Customer + help-AI chat both affected |
| 14. Kill-switch gap in streaming (round 3) | 1/15 | Chat streaming path only |
| 15. Prompt injection (round 3) | 1/15 found + ~8 grep candidates | Admin reconciliation confirmed; per-prompt review needed for others |
| 16. Broken audit-wrapper signature (round 3) | 1/15 | Admin reconciliation only (verified via enumeration of all 29 callsites) |
| 17. `select('*')` user-facing leak (round 3) | 1/15 found + ~5 candidates | CCPA export confirmed |
| 18. maybeSingle masks multi-row (round 3) | 1/15 found + 1 grep | CCPA purge + user-consent renewal |
