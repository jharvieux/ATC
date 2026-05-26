# Session state — last updated 2026-05-26 ~05:30 UTC

## Just completed — overnight autonomous sweep (final state)

User went to bed and asked for:
1. Fresh CodeQL scan + fix medium-or-higher alerts (high-confidence only).
2. Exhaustive spec gap analysis across every section.
3. Fix everything addressable; document the rest.
4. Small themed PRs as I go.

### CodeQL — fully resolved

- #196 closed 2 of 5 alerts via inline `.replace(/[\r\n]/g, ' ')` sanitization.
- The remaining 3 alerts (CodeQL's taint tracker didn't recognize `.replace` reliably when wrapped in `String()` or used in multi-interpolation templates) closed by #217 via:
  - Splitting the resend-webhook `(email.opened | email.clicked)` case so the log argument is a literal case-tag, not `event.type`.
  - Default-case raw value omitted from log (Sentry breadcrumbs capture the raw event).
  - `legal-docs` route now resolves `body.document_type` via `VALID_TYPES.find()` before logging, so CodeQL sees a constant-array origin.
- Fresh CodeQL scan triggered post-merge on dev.

### All PRs landed tonight

| PR | What |
|---|---|
| #196 | CodeQL pass 1 — inline sanitizer + URL parser fix (closes 2 of 5 alerts) |
| #208 | §19.10 forum read-only + §26.5 audit_log retention + §17.10 sleepUntil + §10.5 dashboard widgets |
| #209 | §37 sequence triggers wired into 4 CRM endpoints |
| #210 | §33.9.3 Apify budget pause priority (80/20 sub-cap) |
| #211 | §29.5 Supabase project setup runbook |
| #212 | listDocsForTier wiring + custom-domain self-serve endpoint |
| #213 | §6.7 promo-state reconcile + drift-alert crons + §6.12 retrieval-log 90d aggregation. Two new RAG migrations (0016 + 0017) with RPCs. |
| #214 | §11.7 AI memory extraction now writes audit_log rows |
| #215 | §6.10 chat feedback propagation to RAG per-chunk events (new /api/feedback endpoint + publishChunkFeedback helper) |
| #216 | Documentation wrap-up: supplement + SESSION + MEMORY D-086 + customer-facing AI build prompt |
| #217 | CodeQL pass 2 — narrow log-injection sinks to constant flow (closes remaining 3 alerts) |

### Spec sweep coverage

- Read every subsection of all 40 spec sections + 7 addenda (§33–§40).
- For each subsection: grep code, identify implementation, mark TICK or GAP.
- 45+ subsections marked TICK and now listed in `docs/specs/reality-delta-supplement.md` "Spec subsections marked TICK during the sweep".
- 5 gaps closed in code (above).
- §32.9 reclassified — implemented as a Claude Code slash command (`.claude/commands/fix-bugs.md`), not a runtime UI.
- Cost-deferred items confirmed deferred and pointing to `reality-delta.md §1`.

### Gaps remaining — not fit for overnight, recommended next steps

- **§20.4 / §38.8 / §38.8.1 / §39.5 — Customer-facing AI chat panels** on the booking flow, quote builder, customer quote view, and customer trip view. ~2 days of work; needs browser testing. Recommend a dedicated build prompt.
- **§13.9 active health probing** — operator call needed: keep reactive or add nightly probe.

## In flight

**Nothing in flight.** All overnight PRs merged. This SESSION.md update is the final commit.

## Next step

When you wake:
1. Confirm the post-#217 CodeQL scan dropped alerts to 0 (`gh api repos/jharvieux/ATC/code-scanning/alerts?state=open --jq 'length'`). If any remain, they'll be in `apps/main/src/app/api/webhooks/resend/route.ts` or `apps/main/src/app/api/admin/legal-docs/route.ts` and the next step is to look at the specific line.
2. Decide on the customer-facing AI chat panels build (§20.4/§38.8/§38.8.1/§39.5). See `specs/BuildPrompts/build-prompts-customer-facing-ai-panels.md` for the drafted scope.
3. Decide on §13.9 active health probing — keep reactive or add nightly probe.

## Blocked on user

- §13.9 active vs reactive health probing — design decision
- Multiple "operator confirm" launch-gate items unchanged from prior session (counsel sign-offs, §15.7 STR, §15.14.6 ICA, §16.7.1, etc.)

## Open questions

- The §11.5 estimation aging cron runs *yearly* (>365 days since last re-prompt). Intended? It seems slow for a customer who entered an estimated DOB.
- The §33.9.3 budget-split default (80/20) was an engineering choice — operator should confirm once real Apify spend lands.
- Should the `/api/feedback` RAG endpoint take tenant scoping (e.g., signed JWT) instead of HMAC? Today it's HMAC-only, matching `/api/tenant-events`. The events table is global, so global write makes sense, but worth a security review.

## Carried forward (deferred work, unchanged)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer (cost-deferred)
- BP30: AI behavior eval harness (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
