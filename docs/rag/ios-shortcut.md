# iOS Shortcut — RAG Submission (§22.10)

Operator-built artifact. This document is the contract the Shortcut
must satisfy.

## Purpose

Lets a logged-in user submit content from iOS — Share Sheet from Safari,
Photos, Files, or Notes — to the platform's RAG corpus. Three accepted
payloads:

- Text or URL (most common — Safari Share Sheet → Shortcut).
- Image (Photos → Shortcut) — flows through OCR per `RAG_INGEST_OCR_PROVIDER`.
- PDF (Files → Shortcut) — flows through the PDF parser.

## Authentication

The Shortcut stores an API token in iOS Keychain under key `atc_api_token`.
The token is provisioned out-of-band: user logs in to the platform on
desktop, navigates to Settings → Integrations → iOS Shortcut, clicks
"Generate token" (which issues a long-lived personal access token), then
scans the resulting QR code into the Shortcut's "Set token" action.

## Endpoint contract

Text or URL: `POST /api/rag/submit/ios-shortcut`, body:
```json
{ "text": "...", "url": "https://...", "title": "..." }
```

Image or PDF: `POST /api/rag/submit/file` (multipart/form-data with field
`file`). The Shortcut sets `Content-Type: multipart/form-data` and uses the
"Get file from URL" + "Get contents of URL" pair.

Both call `Authorization: Bearer <token>` from Keychain.

## Distribution

Operator generates a `.shortcut` file using Apple's Shortcuts app on macOS,
exports it, and uploads it to the platform under
`/downloads/ios-shortcut/AddToKnowledge.shortcut`. The download page links
to a short tutorial video on how to install (single tap from iOS Safari).

## What this repo ships

- The `/api/rag/submit/ios-shortcut` endpoint (Next.js App Router route).
- The `/api/rag/submit/file` endpoint (shared with the upload page).
- This document.

The Shortcut definition file itself is generated externally — not in this
repo.
