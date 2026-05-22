# Browser Extension — RAG Submission (§22.9)

Operator-built artifact, not part of this repo. This document is the
contract the extension must satisfy.

## Purpose

Lets a logged-in user submit content to the platform's RAG corpus from any
web page without copy-paste. Three trigger modes:

- A floating button injected onto supported cruise-line/partner domains.
- A right-click context-menu item: "Add to knowledge base".
- A keyboard shortcut.

The captured payload — `{ url, page_title, selection }` — is POSTed to
`/api/rag/submit/extension` in the main app.

## Authentication

Per-user, not per-extension. The extension performs the standard Supabase
OAuth flow (Google or Microsoft) on first install. The resulting session
token is stored in `chrome.storage.local` (or `browser.storage.local` for
Firefox) under key `atc_session`. Every request to the platform attaches
that token in the `Authorization: Bearer <token>` header.

Token refresh: extension calls `/api/auth/refresh` when the token has less
than 5 minutes remaining; if refresh fails, the extension surfaces a
"please re-authenticate" toast and re-runs the OAuth flow.

## Manifest (Chrome / Edge / Firefox MV3)

Minimum required permissions:

```jsonc
{
  "manifest_version": 3,
  "name": "AI Travel Concierge — Knowledge Capture",
  "version": "0.1.0",
  "permissions": [
    "activeTab",
    "contextMenus",
    "storage",
    "scripting"
  ],
  "host_permissions": [
    "https://*/*",
    "<APP_ORIGIN>"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["https://*/*"],
      "js": ["content-script.js"],
      "run_at": "document_idle"
    }
  ],
  "action": { "default_popup": "popup.html" }
}
```

Replace `<APP_ORIGIN>` with the production app origin (e.g.
`https://app.ai-travelconcierge.com/*`).

## Content script responsibilities

- Render the floating button on `host_permissions` domains that match a
  curated allow-list (cruise lines, OTAs, partner sites). The allow-list
  is fetched from `<APP_ORIGIN>/api/rag/extension/allowlist.json` on
  install and cached for 24 hours.
- Capture `window.getSelection().toString()` when the button is clicked.
  If empty, capture the full page text (`document.body.innerText`,
  truncated to 50 000 characters).
- POST to `/api/rag/submit/extension` with:
  ```json
  {
    "url": "https://example.com/page",
    "page_title": "Document Title",
    "selection": "<the captured text>"
  }
  ```
- On 200: show a "Captured" toast with a link to the tenant review queue.
- On 4xx: show the error message.
- On 5xx or network failure: queue locally, retry with exponential backoff,
  surface a "pending sync" badge on the extension icon.

## Background service worker

- Owns the `contextMenus.create({ id: "atc-add", title: "Add to knowledge base" })` registration.
- Routes context-menu clicks to the same POST flow as the floating button.
- Handles the OAuth refresh schedule.

## What this repo ships

- The `/api/rag/submit/extension` endpoint (Next.js App Router route).
- The `/api/rag/extension/allowlist.json` endpoint (returns the per-platform
  curated domain list).
- This document.

The extension package itself is not in this repo. A separate
`apps/browser-extension/` directory will be added when an operator chooses
to invest in it.
