# Session state — last updated 2026-06-07 (end-of-session checkpoint — long session + a prod incident)

## Just completed
- **#850 entity-extraction FK — FIXED + LIVE (beta050).** Anon turns no longer write the anon session id into `ai_call_log.user_id` (FK→users). `entity_extraction` now logs in prod (first time ever). (#861, MEMORY D-180.)
- **#860 cookie auth + platform-admin bypass — merged + live (beta050).** `/api/chat` recognizes the Supabase session cookie; resolves `public.users.id` (not the auth id) for the FK columns; platform admins bypass rate limits (costs still logged). (#865, MEMORY D-181.)
- **Adopted claude-opus-4-8** (#858). Earlier checkpoints #859/#863 (MEMORY D-178/179/180).
- **#862 INCIDENT + revert.** `verifyEnvAtBoot()` at the chat route (#864) 500'd prod chat → reverted (#867). Rolled back to beta048, then **promoted beta050** (rollback had pinned the alias). MEMORY D-182.
- **Diagnosed #868 to the bottom** (the concierge's real failure). MEMORY D-183.
- **Prod ops applied:** `RAG_SERVICE_URL` → canonical `https://rag.ai-travelconcierge.com` (red herring, but cleaner; via `vercel env` + redeploy); RAG `tenant_registry_shadow` booking status → `active` (psql band-aid); reset booking anon chat counters a few times for testing.
- **Issues filed:** #860, #862 (reopened w/ the 4 env vars), #866 (streaming spend-guard), #868 (RAG-grounding stack).

## In flight
- This end-of-session checkpoint (MEMORY D-181/182/183 + SESSION) on branch `chore/checkpoint-session-end`. No code in flight. dev = `afb572c5`, clean.

## Next step
- **#868 — make the concierge actually ground its answers (the real goal, still unmet).** Current blocker is the RAG request-contract 400: `packages/contracts/src/retrieve.ts` `RetrieveRequestSchema` requires `persona_id` + `user_id` as UUIDs, but `callRagRetrieve` sends the persona SLUG (`marcus-cole`) + (anon) `user_id=null`. Fix: relax `persona_id`→`z.string()` and `user_id`→nullable (RAG filters personas via `filters.agent_slug`, only logs `persona_id`); add a contract round-trip test; then **redeploy atc-rag** (manual deploy, ~22h stale); re-run the Bliss query → expect a `rag_retrieval_log` row + a grounded Seattle/Alaska answer.

## Blocked on user
- **Verify the 4 prod env vars** (#862): `RESEND_API_KEY`, `OPENAI_API_KEY`, `MICROSOFT_GRAPH_CLIENT_ID`/`_SECRET` — are they genuinely misconfigured (MS sign-in likely broken in prod) or schema-too-strict? Operator confirms actual values in the Vercel dashboard.
- **#857** operator actions (unchanged): opus-4-8 price verify + eval; `INNGEST_API_KEY` repo secret; `ANTHROPIC_API_KEY` in CI.
- Durable **RAG tenant-status sync** fix (why booking's `active` never reached the RAG shadow; reconcile never ran) — band-aid will drift if a sync overwrites it.

## Open questions
- The RAG request-contract mismatch means RAG-grounded chat has **never worked for any tenant** — needs the contract fix + atc-rag redeploy + a regression test (zero coverage of the main↔rag contract round-trip today).
- `vercel redeploy` may reuse the old env snapshot; the `RAG_SERVICE_URL` change took a normal redeploy to apply — confirm it actually applied if revisiting.
- Untracked working-tree security-scan artifacts (`THREAT_MODEL.md`, `VULN-FINDINGS.*`, `.triage-state/`, `.agents/`, `skills-lock.json`, a stray `specs/...copy.txt`) — not from this session; surface before any cleanup.

## Model note
Per CLAUDE.md end-of-session: this session ran on Opus — switch back to Sonnet next session (`/model claude-sonnet-4-6`) unless continuing the #868 contract work warrants Opus.
