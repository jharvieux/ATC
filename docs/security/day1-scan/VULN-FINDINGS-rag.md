# Vuln-scan findings — apps/rag

Static candidates from `/vuln-scan` (4 focus areas, 56 source files). **Not verified** — `/triage` does the rigorous N-vote verification next. Confidence is scanner self-reported.

**Totals:** 10 findings — 0 HIGH, 5 MEDIUM, 5 LOW (2 low-confidence < 0.4).

| id | sev | conf | category | file:line | title |
|---|---|---|---|---|---|
| F-rag-pii-01 | MED | 0.85 | cost-abuse | packages/contracts/src/ingest.ts:11 | No size cap on ingest content → embedding-cost inflation |
| F-rag-wh-01 | MED | 0.75 | rate-limit-fail-open | api/feedback/route.ts:60 | Rate-limit runs before HMAC verify; spoofable bucket, pre-auth writes |
| F-rag-pii-02 | MED | 0.70 | ssrf | packages/contracts/src/ingest.ts:9 | source_url/image_url accept file://+internal, stored & returned |
| F-rag-wh-02 | MED | 0.70 | replay | api/feedback/route.ts:92 | Captured feedback webhook replayable to inflate ranking (no nonce/ts) |
| F-rag-pii-03 | MED | 0.60 | prompt-injection | api/retrieve/route.ts:198 | Retrieved content returned verbatim, no untrusted-content tagging |
| F-rag-pii-04 | LOW | 0.60 | pii-leak | lib/pii/regex-prefilter.ts:84 | Zero-tolerance PII prefilter false-negatives (separator variants) |
| F-rag-wh-03 | LOW | 0.50 | hmac | api/feedback/route.ts:41 | Hand-rolled timingSafeEqual with early length-return |
| F-rag-iso-01 | LOW | 0.35 | tenant-isolation | api/retrieve/route.ts:40 | Primary vector path is DB-only single-layer (no JS re-filter) |
| F-rag-auth-01 | LOW | 0.40 | jwt-verify | lib/auth/verify-service-jwt.ts:120 | Service JWT verified without audience/issuer binding |
| F-rag-auth-02 | LOW | 0.35 | missing-authz | api/admin/purge-tenant-scoped-chunks/route.ts:15 | Destructive admin routes gate on identifier but not write scope |

Full descriptions, exploit scenarios, and recommendations are in `VULN-FINDINGS.json`.

**Next:** `/triage apps/rag/VULN-FINDINGS.json --repo apps/rag`
