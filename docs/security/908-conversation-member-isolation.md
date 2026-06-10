# #908 — Conversation member-level isolation: design

Status: APPROVED-BY-DESIGN-PASS (fable/Opus-tier, 2026-06-10). Implementation in the same PR.

## The exposure, precisely

`conversations` / `messages` RLS is tenant-level only (`auth_user_in_tenant`), and —
the pivotal finding of the enumeration pass — **RLS never evaluates on the API
routes anyway**: `tenantClient(ctx)` wraps the *service-role* client and injects
`.eq("tenant_id")` filters (its header says so explicitly). The JWT-driven path
that RLS would govern is currently unused for these tables.

So the *active* exposure is the app layer, and it is wider than the issue text:

| Route | Guard before this PR | Exposure |
|---|---|---|
| `GET/PATCH /api/chat/conversations/[id]` | tenant + TA-rows-own-only (#902) | any member reads/retitles any **customer** thread + full transcript |
| `POST /api/chat/escalate` | tenant only | any member escalates anyone's thread |
| `POST /api/chat/conversations/[id]/persona` | tenant only | any member switches the persona on anyone's thread |
| `GET /api/chat/conversations` (list) | own-only (#913) | none |
| `GET /api/chat/ta-conversations` | own-only (#902) | none |

Customers ARE viewer-role members (Booking-tenant model), so "any member"
includes every signed-up customer.

## Access rule (one predicate, both layers)

A caller may access a conversation iff:

- **they own it** — `conversations.user_id` = caller's `public.users.id`
  (covers TA threads per D-195 own-only, and customers' own threads), **or**
- **they are tenant staff** (`role IN ('tenant_owner','agent')`) **and** the
  thread is customer-audience (`audience = 'customer'`) — staff legitimately
  read customer threads (CRM timeline); TA threads stay own-only even for
  owners (D-195).

Anonymous-owned rows (`user_id IS NULL`) fall under the staff clause; the anon
visitor themself never reaches these routes (assertPermission 401s no-session).

## Layer 1 — app guard (closes the live hole)

`lib/chat/guard-conversation-access.ts` exports `guardConversationAccess(db,
ctx, conv)` returning a 404 `Response` (never 403 — existence not leaked) or
null. Generalizes #902's `guardTaThread`; wired into all four routes above.
Fail-closed: unresolvable caller `users` row or lookup error → 404.

## Layer 2 — RLS (defense-in-depth for any future JWT path)

New SECURITY DEFINER helper (§5.1.1 conventions: `SET search_path = ''`,
qualified refs, REVOKE public / GRANT authenticated):

- `auth_user_can_access_conversation(conv_id UUID, target_tenant_id UUID)` —
  the predicate above, evaluated against `public.conversations` directly
  (avoids recursive-RLS subqueries in the `messages` policies).

Policy rewrite (DROP + CREATE):

- `conversations`: SELECT/UPDATE/DELETE `USING auth_user_can_access_conversation(id, tenant_id)`
  (writes also `WITH CHECK ... AND tenant_is_active`). INSERT `WITH CHECK`
  additionally pins `user_id` to the caller's own `public.users.id` — a JWT
  client can only create threads it owns.
- `messages`: all four policies via
  `auth_user_can_access_conversation(conversation_id, tenant_id)` (writes +
  `tenant_is_active`).

Service-role paths (chat route, Inngest, transfer, purge, supervisor — the
entire enumerated production surface) bypass RLS and are untouched.

## What was checked to NOT break

- **CRM timeline** (`/api/crm/contacts/[id]/timeline`) — tenantClient
  (service-role): unaffected; staff also pass the new predicate anyway.
- **Anon chat + §11.6 transfer** — service-role end-to-end: unaffected.
- **Help-AI sessions** — service-role conversation writes: unaffected.
- **Customer reading their own thread** — owner clause.
- The conversation **list** endpoints already self-scope; predicate matches
  their behavior.

## Sequencing / prod gate

RLS-snapshot CI compares the committed snapshot to the **live** DB, so the PR
can only go green after the migration is applied to prod. Per the standing
no-prod-without-asking rule (2026-06-10): build → audits → **operator approves
the policy migration** → apply → regenerate both snapshots → push → merge.
Rollback is a single re-CREATE of the old tenant-level policies.

## Tests

- App guard: matrix over {owner, other-viewer, agent, owner-of-other-thread,
  unresolvable caller} × {customer thread, TA thread, anon thread} — 404s and
  allows per the table above; escalate + persona routes get the forged-id test.
- RLS layer: policy text pinned via the snapshot diff (the live probe runs in
  CI's Cross-Tenant Probe / Playwright stack which applies migrations from
  scratch).
