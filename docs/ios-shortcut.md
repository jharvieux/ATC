# iOS Shortcut — Add to ATC Knowledge Base

An Apple Shortcuts shortcut that lets you share any selected text or webpage from Safari (or any other app) directly to your ATC knowledge base.

This shortcut requires a personal API token. Generate one from **Settings → API Tokens** in your ATC workspace.

---

## Prerequisites

- iPhone or iPad running iOS 16.4 or later
- The **Shortcuts** app (pre-installed on all modern iOS devices)
- An active ATC platform account
- A personal API token (see below)

---

## One-time setup

### Step 1 — Get your API token

1. Open your platform in a browser: `https://yourteam.atcplatform.com`
2. Sign in and go to **Settings → API Tokens**
3. Click **Create**, give the token a name (e.g. "iOS Shortcut"), and click **Create** again
4. Copy the token — it is shown exactly once

### Step 2 — Create the shortcut

Open the **Shortcuts** app and tap the **+** button to create a new shortcut. Add the following actions in order:

#### Actions

1. **Receive input from Share Sheet**
   - Input types: **Text**, **URL**, **Safari web pages**
   - If there is no input: **Continue**

2. **Get details of Safari web page** *(add only if you want the page title)*
   - Input: Shortcut Input
   - Detail: **Name** → save as variable `Page Title`

3. **Text** — paste your **API token** here. Save as variable `ATC Token`.

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

> **Text only.** The shortcut submits text content. File sharing (PDFs, images) is not currently supported by the iOS Shortcut — use the web upload UI for files.

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
| 401 Unauthorized | Token has expired. Repeat Step 1 to get a fresh token and update the `ATC Token` text action |
| 403 Forbidden | Your account may not have the `rag_submissions: create` permission — contact your tenant admin |
| "platform_not_configured" | The platform URL in your `Platform URL` action may be wrong — check for a trailing slash or typo |
| No notification after share | Open the shortcut in the Shortcuts app and run it manually to see the full error response |

---

## Token security

Your API token is stored as plain text inside the Shortcut. To keep it safe:

- Do not share the shortcut via iCloud Sharing — this would expose your token to anyone who installs it
- If your token is compromised, revoke it in **Settings → Integrations** and update the shortcut
- The token is scoped to `rag_submissions: create` only — it cannot read bookings, chats, or other data
