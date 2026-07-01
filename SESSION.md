# Session state — last updated 2026-07-02 00:30 UTC

## Just completed
- **Full-codebase principal-architecture review** (6 parallel agent lenses: idempotency, performance@scale, duplication, reinvented-wheels, complexity, data-layer) over apps/main + apps/rag.
- **39 issues filed, #1575–#1613**, each labeled with the model to fix it (`sonnet` default, `opus` ×5 architectural, new `haiku` label for mechanical fixes). Tiering:
  - Tier 1 money/email (fix before go-live): #1575 UNIQUE constraints (double-payout), #1576 import-promote CAS, #1577 booking-submit host rollback (opus), #1578 platform_revenue loss, #1579 payout re-transfer >24h, #1580 Resend idempotency + stale sender fork, #1581 reminder claim-before-send, #1582 pre-cruise silent loss, #1583 Stripe event ordering, #1584 invite reminder stamp (haiku).
  - Tier 2 scale: #1585 auth tax (opus), #1586 chat hot path (opus), #1587 history limit (haiku), #1588 pagination sweep, #1589 RAG indexes/HNSW, #1590 retention crons.
  - Tier 3 drifted copies/latent bugs: #1591–#1600 (consent cluster, transfer races, HelpAI SSE bug, error-egress sweep, RAG plumbing, quote PDFs, fetchGuarded, escapeHtml, AI batch, groups hardening).
  - Tier 4 maintainability: #1601 proxy manifest (opus), #1602 chat refactor (opus), #1603 docs, #1604 jose tokens, #1605 TTL caches, #1606 money display, #1607 audit-log helper, #1608 template preview, #1609 rag-sync→Inngest (QUESTION), #1610 small cleanups, #1611 soft-bounce semantics (QUESTION).
  - Prevention: #1612 D-091 anti-patterns #21–#26, #1613 shift-left guard batch (incl. jscpd ratchet).
- **Commented on #1527** (audit-service epic) proposing an M10 Reliability/idempotency module + detector candidates for scan-extras.txt, each evidenced by an escaped finding on our own repo.
- MEMORY.md D-312 added; this PR also carries the prior session's uncommitted D-311 entry + SESSION update that never got PR'd.

## In flight
- This docs PR (branch `docs/arch-review-2026-07-01`): MEMORY.md (D-311 + D-312), MEMORY-INDEX.md, SESSION.md. Doc-only → audit-agent exempt.

## Next step
- Merge the docs PR once CI is green.
- Then, when the user gives the go: execute Tier 1 issues (#1575 first — the two UNIQUE-index migrations cap the blast radius of #1576/#1577). Migration PRs must follow docs/runbooks/migrations.md.

## Blocked on user
- #1609 — spec §8.3 decision: is the rag-sync 1s/5s/30s in-request retry schedule a hard spec requirement, or can Inngest-backed delivery replace it?
- #1611 — product decision: is email-soft-bounce suppress-without-resend the intended §23 behavior?
- Whether/when to start executing the review backlog (user said "create the issues"; fixing was not yet requested).

## Open questions
- Carried from last session: RAG ship-stats backfill script (PR #1566) still never dry-run against any DB; `signature_feature` curation path (#1565) deferred.
- Review agents flagged but review deliberately did NOT re-report: vendor-health per-instance gate is documented-intentional (scale consequence noted inside #1586's scope).
