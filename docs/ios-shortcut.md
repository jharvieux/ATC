# iOS Shortcut — Add to ATC Knowledge Base

An Apple Shortcuts shortcut that lets you share any webpage, selected text, PDF, or image from Safari (or any other app) directly to your ATC knowledge base.

---

## Prerequisites

- iPhone or iPad running iOS 16.4 or later
- The **Shortcuts** app (pre-installed on all modern iOS devices)
- An active ATC platform account

---

## One-time setup

### Step 1 — Sign in and copy your access token

The shortcut authenticates using a long-lived API token. To generate one:

1. Open Safari and navigate to your tenant's platform, e.g. `https://yourteam.atcplatform.com`
2. Sign in as normal
3. Navigate to **Settings → API Access** (or equivalent in your tenant)
4. Tap **Generate Shortcut Token** — this creates a token scoped for shortcut use
5. Tap **Copy** to copy the token to your clipboard

> If your platform does not yet show a "Shortcut Token" option, use your current session's access token: in Safari, open the developer console (`Settings → Safari → Advanced → Web Inspector`) and run `(await (await fetch('/api/me')).json())` to confirm auth, then retrieve the token from `supabase.auth.getSession()`. Contact your tenant admin for a dedicated shortcut token.

### Step 2 — Create the shortcut

Open the **Shortcuts** app and tap the **+** button to create a new shortcut. Add the following actions in order:

#### Actions

1. **Receive input from Share Sheet**
   - Input types: **Text**, **URL**, **Safari web pages**, **PDFs**, **Images**
   - If there is no input: **Continue**

2. **Get details of Safari web page** *(add only if you want the page title)*
   - Input: Shortcut Input
   - Detail: **Name** → save as variable `Page Title`

3. **Text** — paste your **access token** here. Save as variable `ATC Token`.

4. **Text** — paste your full platform URL, e.g. `https://yourteam.atcplatform.com`. Save as variable `Platform URL`.

5. **Get Contents of URL**
   - URL: `Platform URL` + `/api/rag/submit/ios-shortcut`
   - Method: **POST**
   - Headers:
     - `Authorization`: `Bearer ` + `ATC Token`
     - `Content-Type`: `application/json`
   - Request Body: **JSON**
     - `text`: Shortcut Input (or selected text variable)
     - `url`: Shortcut Input URL (if input is a URL or web page)
     - `title`: `Page Title` variable

6. **If** the result contains `"status":"queued"` (or HTTP 200):
   - **Show notification**: "Added to Knowledge Base ✓"
   - **Otherwise**: **Show alert** with `Contents of URL` (shows the error)

#### Naming the shortcut

Tap the shortcut name at the top, rename it to **Add to ATC KB**, and tap **Done**.

---

## Using the shortcut

### From Safari

1. Navigate to any supplier page you want to clip
2. Tap the **Share** button (box with arrow pointing up)
3. Scroll down in the share sheet and tap **Add to ATC KB**
4. A notification confirms the submission

### From selected text

1. Select text in any app (Mail, Notes, Safari, etc.)
2. Tap **Share** in the contextual menu
3. Tap **Add to ATC KB**

### From Files (PDFs)

1. In the Files app, long-press a PDF
2. Tap **Share**
3. Tap **Add to ATC KB**

> **Note**: For file uploads (PDFs, images), the shortcut sends the content as base64-encoded JSON. The platform automatically routes it through the same file processing pipeline as the web UI upload. File size limit: 50 MB.

---

## What happens after submission

1. The content lands in your tenant's **Knowledge Review Queue** at `/knowledge/review`
2. An AI normalization pass runs automatically (category suggestion, PII redaction, quality score)
3. A tenant admin reviews and approves the item before it enters the active knowledge base

You will not see an immediate change to AI responses — the review step is required.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| 401 Unauthorized | Token has expired. Repeat Step 1 to generate a fresh token and update the `ATC Token` text action |
| 403 Forbidden | Your account may not have the `rag_submissions: create` permission — contact your tenant admin |
| "platform_not_configured" | The platform URL in your `Platform URL` action may be wrong — check for a trailing slash or typo |
| No notification after share | Open the shortcut in the Shortcuts app and run it manually to see the full error response |
| File too large | The 50 MB limit applies; split large PDFs before sharing |

---

## Token security

Your access token is stored as plain text inside the Shortcut. To keep it safe:

- Do not share the shortcut via iCloud Sharing — this would expose your token to anyone who installs it
- If your token is compromised, generate a new one in **Settings → API Access** and update the shortcut
- The token is scoped to `rag_submissions: create` only — it cannot read bookings, chats, or other data
