# Session state — last updated 2026-06-19 20:20 ET

## Just completed
Two production incidents diagnosed and fixed end-to-end.

1. **"AI temporarily unavailable" (agent support chat)** — `ai_call_log.purpose` CHECK constraint drift (D-273). Anthropic call succeeded; the post-call `ai_call_log` insert rejected newer purposes (incl. `ta_chat_main`) → safeAwait threw → fallback message. Fixed: migration `20260706000000` widens the constraint to all 23 `AICallPurpose` values. Applied to prod via psql + PR #1270 merged. Guard issue #1271. Logged D-273.

2. **RAG retrieval degraded (ungrounded concierge answers)** — `tenant_registry_shadow` drift (D-274). lisa-travel was `active` in main but `onboarding` in RAG → verifier 403 `tenant_inactive` → empty chunks. Root causes: (a) activation never emitted `tenant.status_changed` — fixed in PR #1275 (merged): `activateTenant` now emits, monotonic `source_revision`; (b) nightly reconcile dead since May because `MAIN_APP_URL`+`MAIN_APP_ADMIN_API_KEY` were missing from atc-rag and the key missing from atc-main too. Fixed: provisioned shared key on both + `MAIN_APP_URL=https://ai-travelconcierge.com` on atc-rag, redeployed both, verified handshake 200. Mitigated lisa-travel shadow row via psql. Logged D-274.

## In flight
- Nothing in flight — clean checkpoint on `dev`. About to commit MEMORY (D-274) + this SESSION via a doc-only PR.

## Next step
- Ship the doc-only PR (D-274 + SESSION). Then optionally: confirm the concierge now cites real Bliss itinerary detail; pick up #1273 hardening.

## Blocked on user
- Nothing. (Suggested: re-test Captain Dave / Marcus on Bliss 10/3/26 — should now be grounded.)

## Open questions
- #1273 hardening: `verifyEnvAtBoot()` did not fail the RAG deploy despite required vars missing for months — investigate (instrumentation throw non-fatal on Vercel, or team-shared vars). Also add an operator alert when the reconcile run throws.
- #1274: emit `tenant.status_changed` on suspend/terminate/reject (shadow stays `active` for non-active tenants — inverse leak).
- Orphan shadow rows (2nd "Lisa Travel" c351…, "Bigfoot" 820b…) not in main — the now-working reconcile will warn; decide whether to prune.
- Local `.env.local` has `RAG_SERVICE_URL`/`MAIN_APP_URL` pointing at `.vercel.app` vanity domains (redirect/strip auth); prod uses canonical. Worth fixing local + hardening the RAG fetches to fail loud on 3xx.

## Issues opened this session
- #1271 (sonnet) ai_call_log purpose↔constraint CI guard
- #1273 (opus) reconcile hardening / boot-guard
- #1274 (sonnet) emit status_changed on suspend/terminate/reject
