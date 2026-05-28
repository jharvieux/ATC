# Risk acceptance — document upload virus scanning deferred

**Owner:** Platform operator
**Decision date:** 2026-05-27
**Decision:** Defer the §34.3.1 virus scanning requirement at launch.
**Cross-refs:** punch-list P1 #11, spec §34.3.1, `docs/specs/reality-delta-supplement-2.md`.

---

## What the spec requires

`specs/TechSpec/section-34-addendum-inbound-import.html` §34.3.1:

> Document upload and Gmail attachment paths MUST pass virus scanning before any parsing. Implementation: ClamAV daemon running as a sidecar service, or Supabase storage's native scan if available at build time. Files failing the scan are quarantined (not in tenant-accessible storage), logged to `audit_log` with `action = 'document.virus_detected'`, and the agent is notified via in-app notification. Quarantined files are deleted after 30 days.

## What actually exists

No virus scanning is implemented. The Gmail attachment path (`apps/main/src/inngest/gmail-message-process.ts`) and the manual upload path (`apps/main/src/app/api/imports/upload/route.ts` — when built) route attachments directly to the parsing pipeline.

Confirmed via grep:

```
grep -rn "virusScan\|virus_scan\|clamav" apps/main/src/ → zero matches
```

## Why defer

Vercel Fluid Compute does not support sidecar containers; ClamAV would have to run as a separate service on Fly.io, Render, or similar (~$5-10/month plus operational burden). Supabase Storage does not currently expose a native scan API.

Real-world exposure at launch is bounded:

- **Customer-facing upload paths do not exist yet.** §34 is about INBOUND attachments (Gmail forwarded to the tenant, manual files uploaded by tenant admins). No end-customer can attach a file to anything.
- **Tenant admin uploads reach only the tenant admin's own review surface.** The parsed document and the source attachment live in the tenant's own Supabase Storage bucket, scoped via RLS. A malicious attachment would have to be opened by the tenant admin themselves; there is no fan-out to other users.
- **Gmail attachments arrive from email addresses the tenant chose to integrate with.** The integration is opt-in per-tenant; the tenant is responsible for the inbox's hygiene.
- **The parsing pipeline reads, it does not execute.** PDF/DOCX/XLSX parsing through `pdf-parse` / `mammoth` / `SheetJS` extracts text. None of these execute embedded macros or run untrusted code.

The residual risk is: a malicious attachment that exploits a parser CVE could compromise the serverless function execution context. Mitigations against this:

- **Vercel Functions run in ephemeral isolates** (Fluid Compute reuses warm instances but each invocation is sandboxed).
- **Dependabot + Snyk** scan parser dependencies for known CVEs (per §30.8 dependency scanning).
- **Sentry catches parsing exceptions** so a malformed input that crashes the parser surfaces immediately rather than silently corrupting state.

## Re-evaluation triggers

Revisit this decision (move from acceptance to implementation) when ANY of the following becomes true:

1. **A tenant requests virus scanning explicitly** as part of their compliance program (SOC 2, HIPAA, GDPR processing agreement, enterprise procurement questionnaire).
2. **Customer-facing upload paths land.** Any path where a non-tenant-admin can upload a file changes the threat model materially.
3. **A real incident occurs.** Even a near-miss (malformed file that crashed a parser, or a phishing-style attachment from Gmail integration) is enough to trigger re-evaluation.
4. **Supabase Storage ships native scanning.** If/when Supabase exposes a native scan API, enabling it is operationally cheap and removes the deferral rationale.
5. **The attachment volume exceeds ~100 per day across all tenants.** Higher volume increases the probability that a malicious attachment lands; the sidecar's cost becomes proportionally smaller against scan throughput.

## When implementing

When the re-evaluation triggers fire, implement against this design:

- **Sidecar:** `clamav-rest` on Fly.io exposing `POST /scan` with file body, returning `{ status: 'clean' | 'infected' | 'error', signatures: [...] }`.
- **Call site (Gmail attachment path):** before the parser dispatch in `gmail-message-process.ts`, call the sidecar with the attachment bytes. On `infected`, write `audit_log` row with `action = 'document.virus_detected'`, set a `quarantined_at` timestamp on the document row, and skip parsing. On `error`, fail-CLOSED (skip parsing, queue for retry or manual review — never silently parse on unknown scan status).
- **Call site (manual upload path):** same, before the parser dispatch.
- **Quarantine storage:** a separate `Supabase Storage` bucket the tenant cannot read from. Tenant admin sees a notification with the document type but no attachment download link.
- **Retention:** 30-day purge via existing Inngest cron infrastructure. Add a new function `purge-quarantined-uploads`.
- **Env var:** `VIRUS_SCAN_SIDECAR_URL` (required when feature is enabled) plus a feature flag in `platform_settings` so it can be flipped without redeploy if the sidecar is unhealthy.

## Logged

This decision should be referenced in `MEMORY.md` as a D-NNN entry next time the user runs `/memory-entry`. The spec text in §34.3.1 should be annotated with `> **Status (2026-05-27):** Deferred at launch. See `docs/runbooks/upload-virus-scanning-risk-acceptance.md` for rationale and re-evaluation triggers.` per the reality-delta convention.
