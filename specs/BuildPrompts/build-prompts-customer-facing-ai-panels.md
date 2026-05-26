# Build prompt — Customer-facing AI chat panels (§20.4, §38.8, §38.8.1, §39.5)

**Status:** Draft for review. Not yet executed.
**Source sections:** §20.4, §38.8, §38.8.1, §39.5
**Model:** Sonnet 4.6 (default); switch to Opus for the supervisor-preflight integration if it gets complex.
**Estimated effort:** ~2 days (one engineer, including browser testing).

## Why this is its own build prompt

Tonight's exhaustive spec sweep (MEMORY D-086) confirmed four related gaps that all need the same building block: a customer-facing AI chat panel that:

1. Renders without an authenticated session (token-bound, anonymous customer)
2. Loads page-specific context into the system prompt (booking details / quote options)
3. Goes through the existing §10 supervisor preflight
4. Uses the existing §21 RAG retrieval pipeline (scoped to the booking's tenant)

The four surfaces:

| Section | Surface | Context loaded into prompt |
|---|---|---|
| §20.4 | Booking flow co-pilot (agent-facing, side panel during quote/booking entry) | The agent's current stage + form-field state |
| §38.8 | Quote builder co-pilot (agent-facing, side panel during multi-option quote authoring) | Conversation history, customer memory, existing options |
| §38.8.1 | Customer-side quote AI (customer-facing, on the public quote view page) | Quote options (structured) + persona assigned to conversation |
| §39.5 | Trip itinerary AI (customer-facing, on `/i/[token]` and `/r/[token]` pages) | Booking itinerary, agent notes, customer memory |

§20.4 + §38.8 are agent-facing — easier (auth + tenant context already present). §38.8.1 + §39.5 are customer-facing token-bound surfaces — harder because:

- No authenticated user session
- No tenant context from headers
- The conversation lives on the booking/quote and must persist across visits via the token

## Phasing

**Phase 1 (agent-side, low-risk):**
1. §20.4 booking flow co-pilot
2. §38.8 quote builder co-pilot

Both reuse `/api/chat` with a thin context-loader wrapper. Phase 1 unlocks productivity gains for travel agents without exposing customer-facing surfaces. Browser-testable in dev with a real tenant session.

**Phase 2 (customer-side, higher-risk):**
3. §39.5 trip itinerary AI (on `/i/[token]`)
4. §38.8.1 customer-side quote AI (needs a customer-facing `/q/[token]` page first; today only the API exists)

Each Phase 2 surface needs:
- A new `/api/public/<surface>/[token]/chat` endpoint that validates the token, resolves tenant + booking + persona, then delegates to the supervisor-wrapped Anthropic call
- A new conversation shape that's bound to the token, not to a user
- Anonymous-bound conversation row in `conversations` (matches §11.6 anonymous-to-authenticated transfer pattern)
- Page-side React component that mounts a chat panel + connects to the SSE endpoint

## Common infrastructure to build first

Before any of the four UIs land, build:

### `lib/chat/customer-token-chat.ts`

A thin wrapper that takes:
- `token` (the booking/quote/trip token)
- `surface` (literal: `'itinerary'` | `'quote_view'` | `'quote_builder_copilot'` | `'booking_flow_copilot'`)
- `message` (the customer/agent input)

And returns an SSE stream. Internally:
1. Validates token → resolves tenant_id + booking_id/quote_id + contact_id
2. Loads the surface-specific context payload (booking, quote options, customer memory)
3. Builds the system prompt: persona base + RAG-retrieved chunks + surface context
4. Calls `runSupervisor` (existing §10 preflight) before sending the candidate response
5. Streams the response via SSE
6. Persists the message turn to `conversations` (bound to the token, anonymous user shape)

### Reuse, don't re-build

- `lib/personas/build-system-prompt.ts` — already builds the persona + tone + RAG block
- `lib/rag/retrieve-for-chat.ts` — already does the retrieval
- `lib/supervisor/run-supervisor.ts` — already gates the response

The customer-token-chat wrapper is the **only new code path**. The four UIs are then thin clients calling it.

## Token validation patterns to copy

- `apps/main/src/app/i/[token]/page.tsx` — token resolution for trip itinerary
- `apps/main/src/app/api/public/quote/[token]/select/route.ts` — token resolution for quote acceptance

Both already validate `customer_access_token` against the appropriate table and resolve the tenant_id. Mirror those patterns.

## What NOT to build

- A new chat surface UI library — reuse the existing `MessageBubble` + `renderMessageContent` from `apps/main/src/components/chat/`
- A new SSE stream protocol — reuse `lib/chat/sse-encoder.ts`
- A new persona system — the customer's existing conversation persona is reused

## Test plan (browser, real tenant)

For each phase:
1. Create a real booking / quote / trip via the existing flows
2. Hit the customer-facing URL in an incognito window (no auth)
3. Submit a question; verify the SSE stream delivers a response
4. Submit a sensitive question (price, contract terms); verify the §10 supervisor escalates per §10.5a
5. Verify the conversation row persists across page reloads
6. Verify the `messages.rag_chunks_used` is populated and propagates to RAG feedback per §6.10 (now wired via PR #215)

## Calls Worth Flagging

- **Token rotation:** the customer_access_token is opaque-bearer. If a customer forwards their trip URL, the new viewer can ask the AI questions. Spec is silent on this — assume it's acceptable (no PII beyond what's on the trip page anyway), but the operator should confirm before launch.
- **Rate limiting:** the token-bound chat surfaces need their own rate limits. Suggested: 30 messages / 24h per token. Wire via the existing §27.13 abuse-counter pattern.
- **Anonymous tenant scoping:** since there's no signed-in user, every DB call must use `service_role_client` (already allowlisted for the wrapper file) with explicit `tenant_id` from the resolved token. Defense-in-depth assertion the resolved tenant_id matches the booking/quote tenant_id.
- **Supervisor kill-switch:** the §10.6 kill switch should also pause customer-facing AI surfaces. Today the kill switch is checked in `/api/chat`; the new token-chat endpoint must check it too.

## Deferred (out of scope for this build prompt)

- Multi-language support — assume English only at launch
- Voice input on customer surfaces — defer to Phase 3
- File attachment in customer chats — defer; PII risk too high without §32.13.2 vision-PII detector landed
- Group chat (multi-customer per token) — defer; current model is single-customer per booking
