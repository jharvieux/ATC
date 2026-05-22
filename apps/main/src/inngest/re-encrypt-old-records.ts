// §13.5.1 — Credential re-encryption Inngest job.
//
// Triggered:
//   - Manually: event 'admin/reencrypt_credentials_started'
//   - Daily cron '0 6 * * *' — only runs if APP_ENCRYPTION_KEY_PREVIOUS is set
//     (indicating a key rotation is mid-flight).
//
// Job logic:
//   1. Find all tenant_host_configs rows where credentials->>'key_id' = APP_ENCRYPTION_KEY_ID_PREVIOUS
//   2. Decrypt each with the previous key, re-encrypt with the current key, update the row.
//   3. Emit metric: credentials_at_previous_key_count (logged; alert infra §26).
//
// The job is idempotent: records already at the current key_id are skipped.
// §13.5.3: if this metric is non-zero for more than 7 days post-rotation, log a warning.

import { inngest } from "./client";
import { env } from "@/lib/env";
import { decryptCredential, encryptCredential } from "@/lib/crypto/credential-cipher";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const reEncryptOldRecords = inngest.createFunction(
  {
    id: "re-encrypt-old-records",
    triggers: [
      { event: "admin/reencrypt_credentials_started" },
      { cron: "0 6 * * *" },
    ],
  },
  async () => {
    const e = env();

    if (!e.APP_ENCRYPTION_KEY_PREVIOUS || !e.APP_ENCRYPTION_KEY_ID_PREVIOUS) {
      console.info("re-encrypt-old-records: APP_ENCRYPTION_KEY_PREVIOUS not set — nothing to do.");
      return { credentials_at_previous_key_count: 0 };
    }

    const previousKeyId = e.APP_ENCRYPTION_KEY_ID_PREVIOUS;
    const db = createServiceRoleClient();

    const { data: rows, error } = await db
      .from("tenant_host_configs")
      .select("id, credentials")
      .filter("credentials->>'key_id'", "eq", previousKeyId);

    if (error) {
      throw new Error(`re-encrypt-old-records: failed to fetch rows: ${error.message}`);
    }

    const pending = rows ?? [];
    console.info(
      `re-encrypt-old-records: found ${pending.length} records at previous key_id '${previousKeyId}'.`,
    );

    let reencryptedCount = 0;
    let failedCount = 0;

    for (const row of pending as { id: string; credentials: { ciphertext: string; key_id: string } }[]) {
      const decrypted = decryptCredential(row.credentials);
      if (!decrypted.ok) {
        console.warn(
          `re-encrypt-old-records: failed to decrypt record ${row.id}: ${decrypted.error.code}`,
        );
        failedCount++;
        continue;
      }

      const newEncrypted = encryptCredential(decrypted.value);
      const { error: updateError } = await db
        .from("tenant_host_configs")
        .update({ credentials: newEncrypted })
        .eq("id", row.id)
        // Guard: only update if still at the old key (concurrent-safe)
        .filter("credentials->>'key_id'", "eq", previousKeyId);

      if (updateError) {
        console.warn(
          `re-encrypt-old-records: failed to update record ${row.id}: ${updateError.message}`,
        );
        failedCount++;
      } else {
        reencryptedCount++;
      }
    }

    const remaining = pending.length - reencryptedCount;
    console.info(
      `re-encrypt-old-records: re-encrypted=${reencryptedCount}, failed=${failedCount}, remaining_at_old_key=${remaining}`,
    );

    // §13.5.3: alert if non-zero for more than 7 days.
    // TODO(alert-infra §26): wire this metric to an alerting system.
    if (remaining > 0) {
      console.warn(
        `[metric] credentials_at_previous_key_count=${remaining} ` +
          `— if non-zero for >7 days after rotation, investigate immediately.`,
      );
    }

    return { credentials_at_previous_key_count: remaining, reencryptedCount, failedCount };
  },
);

// §13.5.3 — Quarterly backup-verification reminder cron.
// Emits a reminder for the operator to perform verification manually.
// The cron itself does NOT perform verification (cannot access the offsite backup by design).
export const backupVerificationReminder = inngest.createFunction(
  {
    id: "backup-verification-reminder",
    triggers: [{ cron: "0 9 1 */3 *" }],
  },
  async () => {
    console.warn(
      "[BACKUP VERIFICATION DUE] " +
        "Quarterly encryption key backup verification is due. " +
        "Operator must restore APP_ENCRYPTION_KEY_* from the offsite vault to a sandbox " +
        "and run verifyBackup() against a known test ciphertext per §13.5.3. " +
        "Log result to MEMORY.md as: 'Backup verification: PASSED/FAILED on YYYY-MM-DD for key id vN'.",
    );
    return { reminder_sent: true };
  },
);
