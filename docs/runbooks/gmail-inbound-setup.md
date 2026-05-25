# Runbook: Gmail Inbound Setup (§23.9)

> **Status:** Optional, deferred-launch. The API endpoints exist as stubs.
> Complete this runbook when a tenant requests inbound Gmail integration.

## Overview

Tenants can connect their Gmail / Google Workspace account to receive inbound
email in the CRM activity timeline. The platform fetches email metadata (not
full bodies), matches to existing contacts/conversations, and runs an AI
summary via Haiku.

Auto-reply is off by default and is opt-in per tenant.

---

## Prerequisites

- GCP project with billing enabled
- Operator access to Vercel environment variables
- The tenant's Google Workspace domain (or personal Gmail)

---

## Step 1 — Enable Gmail API in GCP

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select your project (or create one named `atc-gmail-inbound`).
3. Go to **APIs & Services → Library**.
4. Search for **Gmail API** and click **Enable**.
5. Search for **Cloud Pub/Sub API** and click **Enable**.

---

## Step 2 — Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URIs:
   - `https://<your-domain>/api/integrations/gmail/callback` (production)
   - `http://localhost:3000/api/integrations/gmail/callback` (development)
4. Download the JSON and copy:
   - `client_id` → `GMAIL_OAUTH_CLIENT_ID` env var
   - `client_secret` → `GMAIL_OAUTH_CLIENT_SECRET` env var

---

## Step 3 — Create Pub/Sub topic and push subscription

```bash
# Create topic
gcloud pubsub topics create gmail-inbound-atc

# Grant Gmail service account publish permission
gcloud pubsub topics add-iam-policy-binding gmail-inbound-atc \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# Create push subscription pointing at the webhook endpoint
gcloud pubsub subscriptions create gmail-inbound-sub \
  --topic=gmail-inbound-atc \
  --push-endpoint="https://<your-domain>/api/webhooks/gmailpubsub" \
  --push-auth-service-account="<gcp-service-account-email>"
```

---

## Step 4 — Vercel environment variables

Set the following in the project's Vercel environment (Production and Preview):

| Variable | Source / value |
|----------|---------------|
| `GMAIL_OAUTH_CLIENT_ID` | From Step 2 (OAuth credentials JSON `client_id`) |
| `GMAIL_OAUTH_CLIENT_SECRET` | From Step 2 (`client_secret`) — mark as Secret |
| `GMAIL_OAUTH_CLIENT_SECRET_PREVIOUS` | Optional — populate during a rotation window so in-flight callbacks survive the rotation |
| `GMAIL_PUBSUB_TOPIC` | The full topic name created in Step 3 (e.g. `projects/your-project/topics/gmail-inbound-atc`) |
| `GMAIL_PUBSUB_VERIFICATION_TOKEN` | 32-byte hex string — generate with `openssl rand -hex 32` — used by older Pub/Sub auth flows |
| `GMAIL_PUBSUB_AUDIENCE` | The webhook URL itself, e.g. `https://app.ai-travelconcierge.com/api/webhooks/gmailpubsub` — `gmailpubsub/route.ts` verifies Google's signed JWT against this audience |

After setting, redeploy so the runtime picks up the new env.

---

## Step 5 — Wire the OAuth flow in code

File: `apps/main/src/app/api/integrations/gmail/connect/route.ts`

Replace the 501 stub with:
1. Generate an OAuth authorization URL using `GMAIL_OAUTH_CLIENT_ID`.
2. Redirect the tenant admin to Google's OAuth page.
3. On callback (`/api/integrations/gmail/callback`): exchange code for tokens.
4. Encrypt the refresh token using `encryptCredential()` from `@/lib/crypto/credential-cipher`.
5. Store the encrypted token in `host_adapters.config` or a new `tenant_gmail_integrations` table.
6. Call the Gmail `watch()` API to subscribe the mailbox to the Pub/Sub topic.

---

## Step 6 — Implement the Pub/Sub webhook handler

File: `apps/main/src/app/api/webhooks/gmailpubsub/route.ts`

Replace the 501 stub with:
1. Verify the Pub/Sub JWT from the `Authorization: Bearer <token>` header.
2. Decode the base64 Pub/Sub message data to get `{ emailAddress, historyId }`.
3. Load the tenant's encrypted refresh token, decrypt it.
4. Call Gmail API `history.list` to fetch changed message metadata.
5. Match sender email to `contacts.email`.
6. Call Haiku to summarize the email subject + snippet.
7. Insert a CRM activity row linked to the contact.
8. If `auto_reply_enabled` for this tenant: enqueue an auto-reply (off by default).

---

## Tenant opt-in flow

Tenant admin visits `/tenant-admin/integrations` → Gmail card → **Connect Gmail**.
Platform redirects to Step 5's OAuth URL. After OAuth: tenant sees a status badge
"Gmail connected — N messages this month".

---

## Disabling / revoking

1. Tenant admin: click **Disconnect** in the integration settings.
2. Platform: call `gmail.users.stop()` to end the Pub/Sub watch.
3. Delete the stored encrypted refresh token.
4. Delete the Pub/Sub subscription (or let it expire — watch expires every 7 days).
