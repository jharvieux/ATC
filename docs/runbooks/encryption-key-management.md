# Encryption Key Management Runbook

**Spec reference:** §13.5 (credential storage), §13.5.1 (key storage and rotation),
§13.5.3 (disaster recovery controls), §28.13 (env var definitions), §28.20 (rotation policy).

**Criticality:** CRITICAL. These keys protect every tenant's host-adapter credentials.
Losing both keys without an offsite backup makes every encrypted record permanently unrecoverable.
Recovery requires every tenant to re-enter their credentials. There is no other path.

---

## Key environment variables

| Variable | Required | Purpose |
|---|---|---|
| `APP_ENCRYPTION_KEY_CURRENT` | Yes | 256-bit (32-byte) key, base64-encoded. Used for all new writes. |
| `APP_ENCRYPTION_KEY_ID_CURRENT` | Yes | Short identifier for the current key, e.g. `v1`. Stamped on every ciphertext. |
| `APP_ENCRYPTION_KEY_PREVIOUS` | Only during rotation | Previous key, set for the ~90-day rotation overlap window. Read-path only. |
| `APP_ENCRYPTION_KEY_ID_PREVIOUS` | Only during rotation | Short identifier for the previous key, e.g. `v0`. |

The encryption code lives in `apps/main/src/lib/crypto/credential-cipher.ts`.
**Never read the `credentials` JSONB column raw** — always go through that module.

---

## Generating a new key

```bash
# Generate a cryptographically random 256-bit (32-byte) key and base64-encode it
openssl rand -base64 32
```

The output is the value for `APP_ENCRYPTION_KEY_CURRENT`.

---

## Offsite key backup — MANDATORY

**The offsite backup is the single control that prevents Failure Mode 1 (unrecoverable data).**
Skipping it is not an option.

**Operator-chosen backup location (fill in before launch):**
`[OPERATOR: fill in — e.g., "1Password Business vault 'ATC-Platform-Keys'", or "AWS Secrets Manager in account 123456789 / secret atc/encryption-keys"]`

**What to back up:**
- `APP_ENCRYPTION_KEY_CURRENT` value (base64 string)
- `APP_ENCRYPTION_KEY_ID_CURRENT` value
- Date the key was generated

**When to update the backup:**
- At initial setup (before first tenant credentials are saved)
- On every key rotation

---

## Quarterly backup verification — MANDATORY

Perform on: 1st of January, April, July, October (the quarterly cron sends a reminder).

**Steps:**

1. Log into the offsite vault and retrieve the current key set.
2. Set up a throwaway sandbox environment (NOT production, NOT staging-shared).
3. In the sandbox, set `APP_ENCRYPTION_KEY_CURRENT` and `APP_ENCRYPTION_KEY_ID_CURRENT` to the backup values.
4. Run the verification helper against a known test ciphertext:

```typescript
import { verifyBackup } from "apps/main/src/lib/crypto/verify-backup";

const result = verifyBackup({
  test_ciphertext_b64: "<ciphertext from a test record>",
  expected_plaintext: "<known plaintext>",
  backup_keys: { current: "<key from backup>" },
  backup_key_ids: { current: "<key-id from backup>" },
});
console.log(result); // { passed: true }
```

5. If `passed: true`: log the result to MEMORY.md — format:
   `Backup verification: PASSED on YYYY-MM-DD for key id 'vN'`

6. If `passed: false`: the backup is unreliable. **Stop everything.** Investigate immediately.
   The backup must be fixed before any more credentials are written. If the live key in Vercel
   still works (production encrypts/decrypts correctly), generate a new backup from the live
   Vercel env var — but this means you had no working backup until now, which is a security event.
   Log the failure and the remediation to MEMORY.md.

---

## Deleting `APP_ENCRYPTION_KEY_*` env vars

**Vercel may not natively gate env-var deletion behind 2FA.** Until it does, this runbook
enforces the discipline manually:

> **Rule: No one may delete `APP_ENCRYPTION_KEY_CURRENT` or `APP_ENCRYPTION_KEY_PREVIOUS`
> from Vercel without first verifying that the offsite backup is current and valid (per the
> quarterly verification steps above). This is enforced by operator discipline, not by Vercel.**

Recommended: restrict Vercel project access so that only the platform owner account can delete
env vars. Do not share the platform owner credentials.

---

## Key rotation — annual (§28.20)

Rotation is performed once per year or on suspected compromise.

**Steps:**

1. **Generate a new key:**
   ```bash
   openssl rand -base64 32
   ```

2. **In Vercel env vars (all environments that use the key):**
   - Set `APP_ENCRYPTION_KEY_PREVIOUS = <current value of APP_ENCRYPTION_KEY_CURRENT>`
   - Set `APP_ENCRYPTION_KEY_ID_PREVIOUS = <current value of APP_ENCRYPTION_KEY_ID_CURRENT>`
   - Set `APP_ENCRYPTION_KEY_CURRENT = <new key>`
   - Set `APP_ENCRYPTION_KEY_ID_CURRENT = <new id, e.g., next version number>`

3. **Update the offsite backup** with the new key set before deploying.

4. **Deploy.** The boot-time check (`verifyEnvAtBoot()`) validates the new key set on startup.
   If validation fails, the deploy fails fast — no production traffic hits a bad config.

5. **Verify one round of encrypt/decrypt works** against a staging credential after deploy.

6. **Monitor the `re-encrypt-old-records` Inngest job** (daily cron at 06:00 UTC):
   - The job re-encrypts all records still at `APP_ENCRYPTION_KEY_ID_PREVIOUS` under the new key.
   - Monitor `credentials_at_previous_key_count` in logs. It should trend to 0.
   - If non-zero for more than 7 days, investigate — the job may be failing or skipping records.

7. **Once `credentials_at_previous_key_count = 0`:**
   - Remove `APP_ENCRYPTION_KEY_PREVIOUS` and `APP_ENCRYPTION_KEY_ID_PREVIOUS` from Vercel.
   - **Only after verifying the offsite backup is current.**
   - Log completion to MEMORY.md: `Key rotation v{N} → v{N+1} complete on YYYY-MM-DD`.

---

## Failure Mode 1 — Both keys lost

**Effect:** Every encrypted credential is permanently unrecoverable.

**Recovery:**
1. Notify all tenants their host-adapter credentials must be re-entered.
2. In the app, every `tenant_host_configs` row will fail to decrypt.
3. Tenants will see the §13.5.4 banner: "Your credentials cannot be loaded. Please re-enter them."
4. Generate new keys, set them in Vercel, update the backup.
5. Tenants re-enter credentials → stored under new key → verified.

**Prevention:** The offsite backup. If the backup is current, you can restore in minutes.

---

## Failure Mode 2 — Single credential decryption failure

**Symptoms:** One tenant cannot submit bookings; others are unaffected.
The `audit_log` will show `credential.decryption_failed` with a `ciphertext_sha256` fingerprint.

**Recovery:**
1. Tenant re-enters credentials → stored fresh under current key.
2. `credential_status` transitions to `verified` → bookings resume.

---

## Failure Mode 3 — Key rotation gone wrong

**Symptoms:** Some tenants can submit bookings, others cannot. Hard to correlate.

**Diagnosis:** Check `credentials->>'key_id'` across `tenant_host_configs`. If rows have a
`key_id` that matches neither `APP_ENCRYPTION_KEY_ID_CURRENT` nor `APP_ENCRYPTION_KEY_ID_PREVIOUS`,
those rows cannot be decrypted.

**Recovery:** Restore the correct key for that `key_id` from the offsite backup.
Set it as `APP_ENCRYPTION_KEY_PREVIOUS` with `APP_ENCRYPTION_KEY_ID_PREVIOUS = <that key_id>`.
Deploy. The re-encrypt job will pick up the affected rows.

---

## Launch gate

This runbook is a **Phase-0 launch gate** (§13.5.5 "make backup verification a Phase-0 launch gate"):

- [ ] Offsite backup location confirmed and documented above
- [ ] Initial keys generated and backed up
- [ ] `verifyEnvAtBoot()` passes in staging with real keys
- [ ] First quarterly verification scheduled (or performed if near launch)
- [ ] MEMORY.md entry for initial backup confirming offsite location
