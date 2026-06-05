# ATC Knowledge Base Clipper — Browser Extension

Chrome extension that lets you right-click any selected text on a cruise or travel supplier website and save it directly to your ATC knowledge base.

---

## How to install (unpacked, developer mode)

The extension is not yet published to the Chrome Web Store. Until it is, install it as an unpacked extension:

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `apps/extension` folder from this repository
5. The **ATC Knowledge Clipper** icon will appear in your extensions bar

> **Pinning**: right-click the puzzle-piece icon → select ATC Knowledge Clipper → choose **Pin**.

---

## First-time sign-in

1. Click the **ATC Knowledge Clipper** icon in your toolbar
2. Enter your **Platform URL** — the subdomain your agency uses, e.g. `https://yourteam.atcplatform.com`
3. Enter your **email** and **password** (same credentials you use to log into the platform)
4. Click **Sign in**

The extension discovers your Supabase auth config automatically from the platform URL. Your session is stored in the extension's local storage and refreshed automatically — you only need to sign in once per browser profile.

---

## Clipping content

1. Browse to any cruise line, tour operator, or supplier website
2. **Select** the text you want to save (a paragraph, a pricing table, key specs)
3. **Right-click** the selection and choose **Add to ATC Knowledge Base**
4. A small popup opens showing the captured text, source URL, and page title
5. Review the content — you can edit it before submitting
6. Click **Submit to Knowledge Base**
7. The content lands in your tenant's **Knowledge Review Queue** (`/knowledge/review`), where you can approve, edit, or reject it before it enters the active knowledge base

---

## How authentication works

The extension authenticates using your Supabase access token (a short-lived JWT stored in `chrome.storage.local`). It never stores your password. When the token expires, it is automatically refreshed using your refresh token. If refresh fails (e.g. after a password change), you will be prompted to sign in again.

API calls use `Authorization: Bearer <token>` — no cookies are sent.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not reach that platform URL" | Check the URL — it must include `https://` and match your tenant subdomain exactly |
| "Session expired" in submit popup | Click the extension icon and sign in again |
| Submit popup appears blank | The pending capture may have expired (> 1 session); right-click and select again |
| 403 Forbidden | Your account may not have the `rag_submissions: create` permission — contact your tenant admin |
| Extension icon not visible | Go to `chrome://extensions`, confirm ATC Clipper is enabled, and pin it from the toolbar |

---

## Publishing to the Chrome Web Store (future)

When the platform is ready for public release, the extension should be submitted to the [Chrome Web Store](https://chrome.google.com/webstore/devconsole) under the platform's developer account. Key steps:

1. Create a 128×128 icon and 440×280 promotional tile
2. Update `manifest.json` version number
3. Zip the `apps/extension/` folder
4. Upload at the Developer Dashboard → New Item

Until then, the unpacked install approach above works for all tenant admins with access to this repository.
