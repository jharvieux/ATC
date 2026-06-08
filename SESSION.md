# Session state — last updated 2026-06-07 (#850 root-caused + fixed)

## Just completed
- **#850 ROOT-CAUSED + FIXED (#861, merged to dev).** The concierge ignored ship+date itinerary data because `ai_call_log.user_id` FKs `users(id)` and the chat route fed `userId ?? anonSessionId ?? "anonymous"` into retrieval — so every anonymous turn FK-violated the entity-extraction log insert → empty entities → no #826 lookup. Fixed to `user_id: userId` (null for anon). Verified via **live prod repro** + the runtime FK error. MEMORY **D-180**. #850 stays OPEN until a beta deploys and the Bliss query shows an `entity_extraction` row.
- **Adopted claude-opus-4-8** (#858, merged). **Doc checkpoint** (#859). MEMORY D-179.
- **Filed #860** (Bearer-only chat auth → all users treated anonymous; cookie session ignored; customer quota system dead in prod — 0 authenticated chats ever).
- **Filed #862** (`env() called before verifyEnvAtBoot()` throws in the chat path → customer bug-flow feature dead, caught/non-fatal).
- **Unblocked the operator's chat** earlier: reset their anon counters (session 5/5 + fingerprint 10/10) in prod.
- beta048 is live (deploy/smoke/model-gate/inngest-sync green; only the benign auto-merge-back step red).

## In flight
- This doc checkpoint (MEMORY D-180 + SESSION) on branch `chore/checkpoint-850-fix`. No code in flight. dev is clean.

## Next step
- **#860 + staff bypass** (operator approved sequence: #850 first → then #860 + bypass). Make `/api/chat` recognize the Supabase **session cookie** (via `tenantContextFromRequest`, which already supports cookie auth), routing absent/invalid → anonymous (not a hard error); add a platform-admin/staff bypass of the anon caps. Tests + audit + merge. (Task #57.)
- The #850 fix is NOT live until the next beta deploys — operator may want to cut a beta to verify #850 (re-run Bliss query) before/after #860.

## Blocked on user
- **Decision:** proceed to build #860 + staff bypass now, OR cut a beta first to verify #850 live.
- **#857 operator actions** (unchanged; none block code): verify opus-4-8 price; eval 4-8 vs 4-7; add `INNGEST_API_KEY` repo secret; add `ANTHROPIC_API_KEY` in CI.

## Open questions
- #850 awaits post-deploy prod verification (entity_extraction row + correct itinerary answer).
- #860 (auth) + #862 (env boot) open — #860 is the next build; #862 is a smaller follow-up.
- Untracked working-tree security-scan artifacts (THREAT_MODEL.md, VULN-FINDINGS.*, .triage-state/, .agents/, skills-lock.json, a stray specs/...copy.txt) — not from this session; surface before any cleanup.
