# Session state — last updated 2026-06-05 04:35 UTC

## Just completed
- **PR #711 merged** — Chrome extension OAuth cookie auth + iOS Shortcut text-only submission (§22.9/§22.10). Extension replaced email/password with OAuth cookie detection; popup pre-populates URL from stored session → stored tenantUrl → active tab. iOS Shortcut doc updated to reflect text-only limitation; issue #712 opened for long-lived token.
- **PR #713 merged** — Drag-and-drop file uploads on knowledge base, CRM imports, and admin reconciliation. New shared `FileDropZone` component; admin reconciliation page added at `/admin/reconciliation`; linked from admin hub. Audit fixes: CORS headers on 400/307 validation responses, stale comment in extension route, factories.ts docstring updated.
- **Issue #712 opened** — long-lived token generation for iOS Shortcut (Settings → Integrations, needs DB migration + UI).

## In flight
Nothing in flight — clean checkpoint.

## Next step
Nothing pending — both PRs merged, all CI green. Next session can pick from open issues.

## Blocked on user
- **#386** — provisioning a dedicated test Supabase project. Blocks #708 and #709.
- **#712** — long-lived token for iOS Shortcut. Needs design decision on UX and DB schema before starting.

## Open questions
- Dead 307 multipart branch in `ios-shortcut/route.ts` — pre-existing nit from audit; consider removing in a cleanup PR.
- `FileDropZone` has no unit tests — no auth surface, listed as nit in audit, not blocking.
- MEMORY D-152 cross-reference inaccuracy still flagged from prior session (requires explicit user permission to acknowledge via a new MEMORY entry).
