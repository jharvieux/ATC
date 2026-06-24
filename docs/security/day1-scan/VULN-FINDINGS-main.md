# Vuln-scan findings — apps/main

Static candidates from `/vuln-scan` (10 focus areas, 892 source files). **Not verified** — `/triage` does the rigorous N-vote verification next. Confidence is scanner self-reported.

**Totals:** 28 findings — 1 HIGH, 10 MEDIUM, 17 LOW (4 low-confidence < 0.4).

| id | sev | conf | category | file:line | title |
|---|---|---|---|---|---|
| F-pay-01 | HIGH | 0.70 | idempotency | bookings/[id]/cancel/route.ts:217 | Concurrent booking-cancel double-counts clawback (settled-payout branch has no CAS) |
| F-sm-01 | MED | 0.85 | toctou | lib/chat/customer-limit.ts:139 | Customer chat hard-limit counter is read-modify-write, not atomic |
| F-tok-01 | MED | 0.80 | brute-force | public/chat/[token]/route.ts:42 | Public chat rate limit is per-instance in-memory, not Redis |
| F-sm-02 | MED | 0.80 | toctou | lib/chat/anonymous-limit.ts:119 | Anonymous chat limit check+increment not atomic |
| F-sm-03 | MED | 0.75 | quota-bypass | lib/ai/call-wrapper.ts:301 | AI-cost hard gate reads 30s cache + fire-and-forget transition |
| F-pay-02 | MED | 0.75 | cas-zero-row | lib/commissions/state-machine.ts:58 | Commission transition writes without status CAS guard |
| F-ssrf-01 | MED | 0.75 | ssrf | inngest/travel-news-refresh.ts:48 | SSRF via admin-stored RSS feed URL (no allowlist/redirect guard) |
| F-tok-02 | MED | 0.75 | missing-expiry | public/chat/[token]/route.ts:87 | Chat token grants PII-loaded AI access regardless of quote status |
| F-auth-01 | MED | 0.70 | auth-bypass | auth/microsoft-email-prompt/route.ts:25 | Unauthenticated unthrottled OTP route → brute force / identity binding |
| F-leak-01 | MED | 0.70 | info-disclosure | chat/route.ts:234 | Anonymous chat streams raw error.message via SSE |
| F-leak-02 | LOW | 0.80 | info-disclosure | tenant/ai-config/cost-projection/route.ts:40 | Raw DB error.message echoed to authenticated caller |
| F-leak-03 | LOW | 0.75 | info-disclosure | rag/submit/batch/route.ts:70 | Raw DB error.message echoed on batch insert failure |
| F-sm-04 | LOW | 0.60 | state-machine | quote-options/[id]/select/route.ts:62 | Quote 'accepted' transition has no source-state guard |
| F-iso-01 | LOW | 0.55 | idor | bookings/[id]/line-items/route.ts:50 | line-item POST doesn't verify parent booking ownership |
| F-pay-03 | LOW | 0.55 | money-integrity | lib/import/promote.ts:323 | Imported-commission gross uses float math, bypasses money.ts |
| F-tok-03 | LOW | 0.55 | broken-authz | public/quote/[token]/select/route.ts:40 | quote_options lookup not tenant-scoped |
| F-wh-01 | LOW | 0.55 | idempotency | webhooks/resend/route.ts:28 | Resend webhook has no dedup; re-delivery re-enqueues retries |
| F-iso-02 | LOW | 0.50 | idor | crm/contacts/[id]/relationships/route.ts:54 | relationship POST doesn't verify contact ownership |
| F-tok-04 | LOW | 0.50 | missing-expiry | lib/email/unsubscribe-token.ts:91 | Unsubscribe HMAC tokens never expire |
| F-adm-01 | LOW | 0.45 | missing-audit | admin/tenants/route.ts:26 | Two admin GET routes read cross-tenant via raw service-role, no audit |
| F-wh-03 | LOW | 0.45 | idempotency | webhooks/gmailpubsub/route.ts:142 | Gmail history pointer advanced after loop; mid-loop failure reprocesses |
| F-inp-02 | MED | 0.45 | unsafe-upload | lib/rag-ingest/extract-content.ts:137 | Office/PDF parsers decompress before output cap (zip-bomb) |
| F-auth-02 | LOW | 0.40 | missing-authz | proxy.ts:195 | Proxy admin gate accepts any auth cookie shape (structural fragility) |
| F-wh-02 | LOW | 0.40 | idempotency | lib/stripe/webhook-handler.ts:414 | Stripe error path deletes idempotency row before 500 |
| F-inp-01 | LOW | 0.35 | redos | lib/supervisor/checks/arithmetic-check.ts:20 | Nested-quantifier arithmetic regex on AI candidate responses |
| F-auth-03 | LOW | 0.30 | auth-bypass | auth/transfer-session/route.ts:92 | Tenant member can claim an un-claimed anon session |
| F-ssrf-02 | LOW | 0.30 | ssrf | lib/external/cruisemapper/diy-fetcher.ts:76 | CruiseMapper fetcher follows redirects, no internal-IP block |
| F-inp-03 | LOW | 0.20 | path-traversal | imports/source-file/route.ts:22 | Storage path tenant-scope uses startsWith without normalization |

Full descriptions, exploit scenarios, and recommendations are in `VULN-FINDINGS.json`.

**Next:** `/triage apps/main/VULN-FINDINGS.json --repo apps/main`
