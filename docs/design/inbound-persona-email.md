# Inbound email for persona addresses (#890)

**Status:** approved design, 2026-06-10. Phase 1 ready to build (Sonnet); Phase 2 designed but deferred.
**Decision owner:** operator (option chosen: full CRM integration designed, shipped in phases).

## Problem

PR #889's `email_customer` tool sends from persona addresses (`marcus@ai-travelconcierge.com`,
derived in `apps/main/src/lib/personas/tools/handlers/email-customer.ts` → `personaFromIdentity`).
`Reply-To` is set to the tenant's `support_email`, but a customer who replies to the persona
address directly gets a hard bounce: **`ai-travelconcierge.com` has no MX record at all**
(verified 2026-06-10 via `dig MX` — empty). Nothing receives mail on this domain today.

## Provider decision: Resend inbound, not Microsoft 365

The operator has M365 mail, but on a different domain (the apex here has no MX, so M365 is not
receiving for `ai-travelconcierge.com`). Compared:

| | Resend inbound | Microsoft 365 |
|---|---|---|
| Outbound already here | Yes (all platform email) | No |
| Setup | MX record + webhook endpoint | Add accepted domain to M365 tenant, catch-all shared mailbox, Graph app registration |
| Ingest path | `email.received` webhook (signed) pushed to our API | Graph change-notification subscriptions that expire (~3 days) and need a renewal cron, or polling |
| Ongoing cost/ops | None beyond plan | Mailbox license + subscription-renewal moving part |
| Programmatic access | Already integrated (received-email API) | OAuth token management |

**Decision: Resend inbound.** One provider for both directions, webhook-native, no
subscription-renewal cron, no license. The operator's M365 mailbox stays their personal/business
mail and is not in the customer-reply path. Since the apex has no MX today, pointing MX at Resend
breaks nothing — but note it does commit the apex domain's inbound to Resend (M365 could never
also receive on this exact domain later; subdomains remain free).

## Phase 1 — receive, persist, forward (build now)

1. **DNS**: add the Resend inbound MX record to `ai-travelconcierge.com` (exact host/priority from
   the Resend dashboard at integration time — operator action, same place the sending DNS lives).
2. **Webhook** `POST /api/webhooks/resend-inbound`:
   - Signature verification fail-closed (D-091). Per the D-091 round-2 rule, capture a recorded
     signature fixture at integration time and pin the encoding with a unit test.
   - Idempotency keyed on the provider message id; the dedup row is written AFTER processing
     completes, not on receipt (D-091 idempotency ordering).
3. **Tenant resolution** (the persona address does NOT encode the tenant — personas are
   platform-level, so `marcus@` could be answered by a customer of any tenant):
   - Primary: `In-Reply-To`/`References` header → match against `email_log.resend_message_id`
     → that row carries `tenant_id` + `contact_id`. Deterministic and spoof-resistant.
   - Fallback: sender address → unique match in `users`/`contacts`. If the sender exists in
     multiple tenants or zero tenants, leave unresolved.
4. **Persist** to a new `inbound_emails` table: raw provider payload, parsed from/to/subject/text,
   `tenant_id` (nullable until resolved), `contact_id` (nullable), resolution method, provider
   message id (unique). RLS: tenant members read their tenant's rows; service-role writes.
5. **Forward**: when tenant is resolved, send a copy to the tenant's `support_email` via the
   existing `sendEmail` helper (category-rate-limited) so no reply is silently lost. Unresolved
   messages surface on a small platform-admin list (`/admin/email-samples` neighborhood) instead
   of being dropped.

## Phase 2 — CRM integration (designed, deferred)

- Attach resolved inbound emails to the customer's CRM timeline: insert a `messages` row on the
  matching conversation (or a new conversation) with a `source: 'email'` marker — the `messages`
  table needs a nullable `source` column (expand-only migration); `role` stays `'user'`.
- Conversation matching: `contact_id` + the `email_log` row's conversation linkage where present;
  otherwise create a conversation titled from the subject.
- TA experience: timeline entry gets a **"Draft reply"** action that pre-fills the §904 composer
  (`/concierge/draft`) with the inbound body. This preserves the D-193 draft-only contract — the
  route still imports no email module; the TA sends from their own client. Inbound routing is the
  on-ramp for D-193 send-on-behalf later, not a bypass of it.
- Notify the TA (tenant notification email) when an inbound reply lands on their conversation.
- Attachments: Phase 2 stores metadata only and fetches bodies on demand via Resend's
  received-email-attachment API; no blob storage in Phase 1.

## Out of scope (both phases)

- AI auto-replies to inbound mail.
- Send-on-behalf from the composer (D-193 owns that sequencing).
- Inbound on tenant-verified custom from-domains (§16.4) — those tenants' replies already go to
  their own mail infrastructure.

## Security notes

- Webhook: fail-closed signature check; reject oversized payloads; never trust the claimed sender
  for tenant resolution without a `References` match (a forged sender must not attach mail to
  another tenant's CRM — the fallback path requires a UNIQUE sender match and only forwards,
  Phase 2 thread-attach requires the References match).
- Two-layer tenant isolation on `inbound_emails` (RLS + explicit `.eq("tenant_id", ...)`).
- Record the provider's SPF/DKIM verdicts on the row for later abuse triage.
