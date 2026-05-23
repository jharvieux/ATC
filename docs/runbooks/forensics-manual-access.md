# Forensics snapshot manual access

> **Owner:** Platform admin + legal counsel.
> **Spec ref:** §26.5a.
> **DO NOT** run any decrypt command from CI or from application code.

## When manual decryption is appropriate

- A court order has been served, requiring production of specific snapshot(s).
- A signed engagement letter from outside counsel documents an internal investigation that requires snapshot review.
- An internal security incident has been declared (`POST /api/admin/security-incident/declare`) and the incident commander has authorized snapshot review.

## Authorization checklist (operator + reviewer sign-off)

- [ ] Case reference (court order number, engagement letter ID, or incident number).
- [ ] Authorizing party (counsel, executive, oncall commander) — name + date.
- [ ] List of snapshot IDs being decrypted.
- [ ] Stated purpose (one sentence).
- [ ] Reviewer (peer engineer who witnesses the decrypt run).

Record the signed checklist alongside the decrypted output. Both go to a secure case folder, not source control.

## Operator workstation requirements

- Local clone of the repo, on `dev` branch or the relevant tag.
- `FORENSICS_ENCRYPTION_KEY_CURRENT` (and any `FORENSICS_ENCRYPTION_KEY_PRIOR_N` needed for older snapshots) loaded as env vars.
- Network access to the production Supabase Postgres (read).
- A scratch directory **outside the repo working tree** for decrypted output.

## Command (illustrative)

```bash
pnpm tsx scripts/forensics-decrypt.ts \
  --snapshot-id=<uuid> \
  --case-ref=<external-ref> \
  --output-dir=/tmp/forensics-case-<ref>
```

The script wraps `decryptForensicsSnapshot()` inside a `withPlatformAdminAudit` shim so an `audit_log` row is written with `action = 'forensics.manual_decryption'` and the case ref in `changes`. **Do this manual audit step even if the script doesn't:**

```sql
INSERT INTO public.audit_log (actor_user_id, actor_type, action, resource_type, resource_id, changes)
VALUES (
  '<operator-user-id>',
  'admin',
  'forensics.manual_decryption',
  'forensics_log',
  '<snapshot-id>',
  jsonb_build_object('case_ref', '<ref>', 'authorized_by', '<name>')
);
```

## After the review

- [ ] Securely delete the decrypted output from the scratch directory.
- [ ] Document the snapshot ID + case ref in the incident log (`docs/runbooks/incident-response.md`).
- [ ] If the snapshot should be preserved past its 90-day retention, set `legal_hold = TRUE` via the `setLegalHold` helper (also wrapped in `withPlatformAdminAudit`).

## What this runbook explicitly forbids

- Running the decrypt command from CI, from production server-side code, or from any always-on process.
- Storing decrypted output in source control, in shared chat tools, or in any persistent location not designated as the case folder.
- Sharing decryption keys outside the operator + counsel pair.
- Bypassing the audit_log entry — the audit row is the forensic record that this access happened.
