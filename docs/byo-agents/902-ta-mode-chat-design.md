# #902 — TA-mode chat: design

Status: APPROVED — operator signed off 2026-06-09 (spend model + visibility resolved below).
Phase 1 of the BYO dual-role persona track (MEMORY D-193/D-194; issues #902 → #903 → #904).
Designed 2026-06-09 against dev @ 63b3a038.

## Goal

A tenant member (the TA) opens a chat in the tenant dashboard, picks any of the six
travel personas, and gets (a) travel-domain expertise in a professional-peer register
and (b) grounded answers to platform how-to questions — one chat, no wrong door.
Customer-facing chat behavior is byte-identical after this change.

## What exploration changed about the issue's assumptions

1. **"Help docs into RAG" is unnecessary.** `lib/help-ai/docs-loader.ts` already
   loads all of `content/help/*.md` in-process with fuzzy search (`searchDocs`),
   used today by `/api/help/docs/search`. Twelve markdown docs do not need
   embeddings, the rag service, or a sync job. TA-mode grounding injects doc
   content directly from the loader (§"Platform-help grounding" below).
   **Rejected:** vector ingestion into apps/rag — a second service hop, an
   ingestion pipeline, and deploy coupling (MEMORY: rag deploys are manual) for
   corpus size 12.
2. **A platform-help persona already exists** (`help_ai`, §32.4, `kind:
   platform_help`) with sessions, routes, and a panel — but the panel is mounted
   only in *platform admin* UI, and its structured bug/feature flows are out of
   scope here. TA-mode chat does NOT reuse the help_ai persona; the travel
   persona answers platform questions itself (operator: "one chat"). The help_ai
   separation rule ("never forward a customer's travel conversation through this
   persona") is about *customers*; it is not violated by a TA-audience prompt
   block.
3. **Found gap (bug, tracked separately):** the help_ai message route claims doc
   grounding in its prompt ("grounded in the platform docs", "cite docs where
   possible") but `buildSystemPrompt(persona_slug='help_ai')` is called with NO
   doc content and the route never calls `searchDocs` — the model answers
   platform questions from its prompt body + priors. The
   `buildHelpContextBlock()` introduced here is the retrofit vehicle. Issue: see
   "Artifacts" below.

## Audience model

```
type ChatAudience = "customer" | "tenant_member";
```

- **Derivation is server-side only.** The client *requests* TA mode (body
  `mode: "ta"` from the dashboard surface), and the route *verifies* it:
  authenticated Supabase session AND membership row in the resolved tenant AND
  `role IN ('tenant_owner','agent')`. Anything else → **403, fail closed** (no
  silent downgrade to customer mode — fail loud; a downgrade would silently
  produce customer-register answers and confuse the TA).
- `viewer` is excluded by construction: platform customers ARE viewer-role
  members (Booking-tenant model, MEMORY project note), so role — not membership —
  is the boundary.
- Anonymous path, signup wall, anon cookies: structurally unreachable in TA mode
  (the 403 fires before any anon handling).
- Why client-requests + server-verifies (vs auto-detect by role): a
  tenant_owner browsing the public storefront should still get the customer
  experience there. The *surface* declares intent; the *server* enforces
  eligibility.

## Prompt architecture (the customer-prompt-unchanged invariant)

Three-layer build (`build-system-prompt.ts`) stays. The audience knob is
threaded as `audience?: ChatAudience` defaulting to `"customer"` — every
existing caller compiles unchanged and produces byte-identical output (existing
persona snapshot tests are the regression net; plus one new equality test).

For `audience === "tenant_member"`:

- **Layer 1 (persona base): untouched.** All six persona bodies stay as-is —
  identity, voice, expertise survive verbatim. No persona content edits.
- **Layer 2 (platform constraints): TA variant.** `assemblePlatformConstraints`
  gains the audience param. TA variant: keeps AI-disclosure ("you are an AI" is
  non-negotiable in both registers), keeps safety/prohibited topics; drops
  customer-protective framing that's wrong for a trade audience (booking-system
  deferral language, price-hedging — the #828 family of rules); adds the
  TA-register block: you are talking to a travel professional who operates this
  agency; commissions, fare-class margins, upsell strategy, and competitive
  line comparisons are in scope; never fabricate platform features (answer
  platform questions ONLY from the PLATFORM HELP CONTEXT block or say the docs
  don't cover it); no other tenant's data, no platform-internal details beyond
  the docs, no commitments on the platform's behalf.
- **Layer 3: tenant addendum SKIPPED in TA mode.** It's tenant-authored
  *customer positioning* ("how this persona is styled for my customers") — in a
  TA-facing turn the tenant is the audience, not the author's target. Tone
  calibration pinned to professional (level 2); customer tone-detection is
  bypassed entirely. Customer-context block: omitted (no contact).
- **Travel RAG: same `retrieveForChat`,** tenant-scoped exactly as today (JWT
  carries tenant_id; rag verifier cross-checks). Two TA-mode inputs differ:
  `customer_has_booking: true` (the closed-promo gate hides promos from
  non-booked *customers*; a staff member is entitled to see their own tenant's
  promos), and `contact_id: null`.

## Platform-help grounding

New `lib/chat/help-context.ts` → `buildHelpContextBlock(message: string):
string | null`:

- Scores all docs per TA turn with a token-based matcher over `loadAllDocs()`
  (in-memory, microseconds): qualification requires a TITLE-token hit (platform
  questions name the feature — "branding", "quote", "billing"), body hits only
  refine rank. *Implementation note: the originally-planned `searchDocs()`
  reuse was dropped — it substring-matches the whole query, which suits the
  help search box but never matches a conversational message.* Top 2 docs emit
  a `PLATFORM HELP CONTEXT` block — doc title + body, capped (~6k chars
  total), with the embedded instruction: answer platform questions only from
  this block; if it doesn't cover the question, say so and point at the Help
  page — never invent platform behavior.
- No hits → returns null → section omitted (same omit-when-empty convention as
  `displayable_assets_block`).
- **Customer isolation is structural, not filtered:** the builder is invoked
  only on the TA branch of the chat route. There is no help content in any
  customer-audience prompt to filter out. (Acceptance criterion "help chunks
  never appear in customer retrieval" is satisfied by construction; the test
  asserts the customer branch never calls the builder.)

## Route mechanics (`/api/chat`)

Same route — reuses streaming, supervisor/deny-list, kill switches
(`ai_paused_by_platform`, chat flags), `ai_call_log`, vendor-health
instrumentation for free. The TA branch:

1. Verify audience (above). 403 on failure.
2. Skip: anon handling, signup wall, customer-memory writes, tone-change
   detection, customer tiers.
3. Spend + rate limiting (operator-decided 2026-06-09):
   - **Primary governor is the existing tenant AI-cost state machine**
     (`lib/abuse/snapshot.ts` / `state-machine.ts`, `ai_cost_limit_state`
     ok→soft1→soft2→hard) — TA turns inherit it by going through the same
     instrumented wrappers with purpose `ta_chat_main`, metering into
     `tenant_usage_metrics` like all other tenant AI spend.
   - **Plus a 200/day/member backstop cap** (platform-settings-tunable,
     fail-closed on DB error, same posture as the D-191 concierge email
     category) so one member can't burn the tenant's monthly allowance in the
     first week before the cost state machine escalates.
   - **Dependency flag:** #866 — `instrumentedClaudeStream` does not enforce
     `ai_cost_state='hard'`, so the breaker does not currently halt *streamed*
     turns. TA mode adds a staff-driven streaming spend surface, raising
     #866's priority; the daily cap is the effective stop until it's fixed.
4. Persist conversation + messages with `conversations.audience =
   'tenant_member'`.

**Migration (expand-only):** `conversations.audience text not null default
'customer'` + check constraint. Additive; no readers change meaning (default
backfills existing rows as customer). The ~10 existing `.from("conversations")`
readers were enumerated; the only behavioral touch is the conversation-list
endpoints filtering by audience so TA threads don't appear in customer chat
history or CRM timelines (and vice versa). No column drops — §38 contract
phase N/A.

## UI

New tenant-dashboard page (route group `(tenant)`, e.g. `/concierge`), nav
entry alongside CRM/Settings. Reuses the existing chat experience components
with a persona picker and `mode: "ta"`; conversation list scoped to the
signed-in member + `audience='tenant_member'`. No new chat rendering code —
markdown/citations/lightbox come along from the customer surface.

## Test plan (intent, not just behavior)

- **Boundary:** anon → 403; viewer member → 403; agent/owner of tenant A
  requesting against tenant B → 403; agent → 200. (Why: the audience gate is
  the single new auth surface; a customer reaching TA register is the
  worst-case failure of this feature.)
- **Customer invariance:** `buildSystemPrompt(audience: "customer")` equals
  pre-change output for all six personas + help_ai (snapshot equality). (Why:
  the no-regression promise to existing customers is the contract.)
- **TA prompts:** snapshot per persona with audience=tenant_member; asserts
  Layer-1 body intact, TA block present, tenant addendum absent.
- **Help grounding:** platform-question fixture → block present with doc
  content; travel-question fixture → null; customer branch never invokes the
  builder (spy).
- **Limits:** member over daily cap → 429; DB error during limit check → denied
  (fail-closed), not allowed.

## Sequencing

- **PR A — API-complete TA mode:** audience threading + Layer-2 variant +
  help-context builder + route gate + migration + limits. New behavior on an
  API route + a migration → **Opus first-audit** per CLAUDE.md.
- **PR B — dashboard surface:** page, nav, persona picker wiring.
- **Separate issue — help_ai grounding retrofit:** wire
  `buildHelpContextBlock` into the help_ai message route (the §"found gap").
  Not bundled here (surgical-changes rule); trivially small once PR A lands.

## Resolved questions (operator, 2026-06-09)

1. **Spend control:** governed by the existing AI-cost state machine
   (% -of-plan escalation), with a 200/day/member backstop cap so a single
   member can't exhaust the monthly allowance early. See route mechanics §3,
   including the #866 streaming-enforcement dependency.
2. **Cross-member visibility:** own-only — every member, including
   tenant_owner, sees only their own TA conversations. Widening later is easy;
   narrowing after launch would breach expectations.
