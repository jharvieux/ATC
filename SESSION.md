# Session state — last updated 2026-06-05 17:00 UTC

## Just completed
- Ran `/triage apps/main/src/VULN-FINDINGS.json --repo apps/main/src` (3-vote adversarial verifiers): 44 findings → 20 TP, 13 needs-manual-test, 10 FP, 1 duplicate
- Updated all 43 GitHub issues (#715–#757) with triage verdicts, severity, labels (`triage:confirmed` / `triage:false-positive` / `triage:needs-manual-test` / `triage:duplicate`), and closed 10 FP + 1 duplicate
- Wrote `apps/main/src/TRIAGE.json` + `apps/main/src/TRIAGE.md` (ranked output)
- Opened PR #758 `feature/rag-security-day1` — RAG day-1 remediation:
  - f020 (#733): SERVICE_JWT_KEY_ID → SERVICE_JWT_KEY_ID_CURRENT (env var alignment, signer + env.ts + .env.example)
  - f007/f008 (#724): timingSafeEqual HMAC in tenant-events + platform-settings-events
  - f038 (#751): fail-closed on involuntary_content termination (Inngest throw)
  - f017 (#731): content_hash SHA-256 in approve/tenant, approve/global, replace-chunk

## In flight
- PR #758 feature/rag-security-day1 — audit agents running (D-091 + pre-PR)

## Next step
- Wait for audit agents on PR #758 to complete; fix any findings; merge
- Address remaining confirmed HIGH TPs not in PR #758:
  - f001 (#715): cross-tenant trip_resources read — service-role query missing tenant_id
  - f028 (#741): quote acceptance TOCTOU — public route needs CAS status guard
  - f022 (#735): OTP brute-force — needs Redis in main app (user decision: see open question)
  - f012 (#716): PII bypass via reviewer edits — needs product scoping
- Medium TPs: f002 (#719), f003 (#717), f033 (#746), f034 (#747), f024 (#737), f014 (#727), f021 (#734), f023 (#736), f027 (#740), f031 (#744), f035 (#748)

## Blocked on user
- **#386** — provisioning a dedicated test Supabase project. Blocks #708 and #709.
- **#712** — long-lived token for iOS Shortcut. Needs design decision on UX and DB schema.
- **#735 (f022)** — OTP brute-force: Redis is already in RAG service but not `apps/main`. Fixing properly requires adding Redis to main — confirm before starting.
- **#716 (f012)** — PII bypass: which PII fields should be re-checked on `body.edits.content`? Same Haiku pipeline as ingest?
- **#734 (f021)** — Decompression bomb: what cap value for `MAX_EXTRACTED_CHARS`? (5MB? 10MB? Affects large document quality.)

## Open questions
- f044 comment at line 114-116 (apps/rag/src/app/api/retrieve/route.ts) has a documentation inaccuracy — low priority doc fix
- Dead 307 multipart branch in `ios-shortcut/route.ts` — pre-existing nit from prior session
