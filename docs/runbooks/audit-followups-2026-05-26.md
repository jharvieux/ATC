# Audit follow-ups — 2026-05-26 (D-091 / Greptile review)

Findings from Greptile's audit of auth, crypto, Stripe, Apify, and RAG surfaces, plus a grep-based sweep of the rest of the codebase using the same pattern templates.

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

### Credentials in URL — needs targeted sweep

Greptile flagged 2 sites: `apify-pricing-adapter.ts:226` and `cruisemapper-actor.ts:102`. Grep with stricter regex came back empty; the pattern is too varied to grep cleanly.

**Recommended remediation**: Ship `atc/no-credentials-in-url` ESLint rule (this PR). Catches the pattern at lint time on any future fetch with credentials in URL.

### Service-role usage without ESLint exemption — many sites in `apps/main/src/app/api/forums/*`

Forums + sandbox routes import `createServiceRoleClient` directly. The existing `atc/no-direct-service-role-import` rule must be using an allowlist (need to check). Audit: does each forum route legitimately need service-role, or should it use `tenantClient(ctx)`?

**Recommended remediation**: separate scoped audit — not infrastructure work.

### Tenant_id leak in responses — needs Greptile-style analysis

Grep can't distinguish data-leak `Response.json({...row})` from validation-error `Response.json({error: "tenant_id required"})`. Pattern requires AST-aware analysis.

**Recommended remediation**: cover via Greptile audits on remaining high-risk areas (next 5 in queue).

## Patterns identified — preventive infrastructure

See `docs/runbooks/anti-patterns.md` for the consolidated pattern catalog and the ESLint rules / CLAUDE.md doctrine added to prevent recurrence.
