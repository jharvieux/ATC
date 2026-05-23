# Secret rotation policy

**Owner:** platform operator
**Spec refs:** §28.4, §28.9, §28.10, §28.13, §28.20, §28.22 (second call-out)
**Audience:** anyone rotating any platform secret

## Cadence summary (§28.20)

| Secret class | Cadence | Rotation method |
|---|---|---|
| Inter-service JWT keys (`SERVICE_JWT_PRIVATE_KEY` + `_PUBLIC_KEY`) | Annually | Overlap window: deploy new public key as `_PREVIOUS`, then new private key, then remove old. Test in staging first. |
| App encryption keys (`APP_ENCRYPTION_KEY_CURRENT`) | Annually | Overlap with `_PREVIOUS`; lazy re-encrypt on next write. |
| Forensics encryption keys (`FORENSICS_ENCRYPTION_KEY_CURRENT`) | Annually | Two-step grace: `_PRIOR_1` and `_PRIOR_2` (operator deviation from spec; MEMORY D-062). |
| OAuth client secrets (Google, Microsoft, Facebook, Apple-when-enabled) | Annually | Generate in provider console; deploy as `_PREVIOUS`; switch active; remove old after overlap. |
| Anthropic / OpenAI / Stripe keys | On compromise; vendor-recommended cadence otherwise | Single-key rotation: replace in Vercel, redeploy. No overlap. |
| Supabase service-role keys (`SUPABASE_SERVICE_ROLE_KEY`) | On compromise only; no regular rotation | Regenerate in Supabase dashboard, update env, redeploy. High-friction. |
| `PLATFORM_PEPPER` | **NEVER** | Rotation orphans every existing customer hash. Document compromise as a key-compromise incident; do not rotate. |
| `SUPABASE_JWT_SECRET` | Aligned with Supabase project rotation | Coordinated with Supabase ops; rare. |

> **NOTE:** Microsoft Entra/Azure AD client secrets have a maximum lifetime of 2 years. Annual rotation fits well inside that. Google and Facebook don't enforce expiry by default but annual rotation is sound discipline regardless.

---

## Per-secret-class detailed procedures

### Inter-service JWT keys (§28.4) — annual

The **highest-risk** rotation. A botched rollout means the RAG service rejects
every inter-service request from the main app. Test in staging before each
production rotation. Failed rotations roll back via re-applying the old key
values and redeploying.

**Pre-rotation:**
- [ ] Confirm last successful staging rotation date (operator log).
- [ ] Generate new RS256 keypair locally:
  ```sh
  openssl genrsa -out private.pem 2048
  openssl rsa -in private.pem -pubout -out public.pem
  ```
- [ ] Pick a new key ID (kid). Convention: `v<N>` where N increments.

**Rotation steps (production):**

1. **Stage the new public key on the RAG service.** In Vercel for the RAG
   project, set `SERVICE_JWT_PUBLIC_KEY_PREVIOUS = <new public key>` (any
   temporary stash is fine; this just gets the new key onto the RAG side first).
2. **Redeploy the RAG service.** RAG now accepts tokens signed with **either**
   the current public key (via `SERVICE_JWT_PUBLIC_KEY`) or the new key
   (via `SERVICE_JWT_PUBLIC_KEY_PREVIOUS`).
3. **In Vercel for the main app**, swap in three vars atomically:
   - `SERVICE_JWT_PRIVATE_KEY = <new private key>`
   - `SERVICE_JWT_KEY_ID = <new kid>`
4. **Redeploy the main app.** All new outbound tokens are signed with the new
   private key. RAG verifies them against the new public key (which is in
   `_PREVIOUS` for now — that's fine; `SERVICE_JWT_ACCEPTED_KEY_IDS` lists both).
5. **Update `SERVICE_JWT_ACCEPTED_KEY_IDS`** on RAG to include the new kid.
   Redeploy RAG. (Skip if the existing list already includes the new kid.)
6. **Wait the overlap window** — recommended **24 hours**. This allows any
   in-flight short-lived tokens from before the swap to expire naturally.
7. **In Vercel for the RAG project**, promote the new public key:
   - `SERVICE_JWT_PUBLIC_KEY = <new public key>` (was previously in `_PREVIOUS`)
   - Remove `SERVICE_JWT_PUBLIC_KEY_PREVIOUS`.
   - Update `SERVICE_JWT_ACCEPTED_KEY_IDS` to list only the new kid.
8. **Redeploy RAG.** The old kid is now rejected. Rotation complete.

**Verification:**
- [ ] Synthetic inter-service call (RAG-side endpoint hit via main) succeeds.
- [ ] No `[jwt-verify:failed]` audit-log rows accumulate after the final swap.

**Rollback:** Restore the previous `SERVICE_JWT_PRIVATE_KEY`, `SERVICE_JWT_KEY_ID`,
and `SERVICE_JWT_PUBLIC_KEY` values in Vercel and redeploy both services. The
old keypair remains accepted as long as the kid is in `_ACCEPTED_KEY_IDS`.

---

### App encryption keys (§28.13, §13.5) — annual

**Pre-rotation:**
- [ ] Verify the latest backup-verification timestamp (`APP_ENCRYPTION_BACKUP_VERIFIED_AT`)
      is less than 100 days old (§13.5.3).
- [ ] Generate new key: `openssl rand -base64 32`.

**Rotation steps:**

1. In Vercel (production), shift the existing keys down:
   - `APP_ENCRYPTION_KEY_PREVIOUS = <was APP_ENCRYPTION_KEY_CURRENT>`
   - `APP_ENCRYPTION_KEY_ID_PREVIOUS = <was APP_ENCRYPTION_KEY_ID_CURRENT>`
2. Set the new current:
   - `APP_ENCRYPTION_KEY_CURRENT = <new key>`
   - `APP_ENCRYPTION_KEY_ID_CURRENT = <new kid>`
3. Redeploy. New writes use the new key; reads transparently try
   `_CURRENT` then `_PREVIOUS` via the credential cipher's key registry.
4. **Lazy re-encryption** happens on next write to each ciphertext record.
   For credentials that may be untouched for years (e.g., dormant host
   adapter creds), accept the long tail.
5. After 12 months at the new key — or sooner if traffic patterns suggest
   most ciphertext has been touched — the next rotation cycle promotes
   `_CURRENT` to `_PREVIOUS` again. The old `_PREVIOUS` from this cycle
   ages out only when the chain length exceeds what the cipher supports
   (currently 2).

**Verification:**
- [ ] Sample-decrypt a recently-written credential (new key).
- [ ] Sample-decrypt an older credential (previous key).
- [ ] Run quarterly backup-verification (§13.5.3) and update
  `APP_ENCRYPTION_BACKUP_VERIFIED_AT` to today's ISO timestamp.

---

### Forensics encryption keys (§28.13, §26.5a) — annual

Forensics keys use a **two-step grace window** (`_PRIOR_1` then `_PRIOR_2`)
rather than the single `_PREVIOUS` the spec suggests. Operator decision
during BP25/26 — gives a second rotation cycle to age out old ciphertext
before keys are deleted (MEMORY D-062).

**Rotation steps:**

1. Generate a new 32-byte base64 key.
2. In Vercel, shift the chain:
   - `FORENSICS_ENCRYPTION_KEY_PRIOR_2 = <was PRIOR_1>` (drop the oldest)
   - `FORENSICS_ENCRYPTION_KEY_ID_PRIOR_2 = <was ID_PRIOR_1>`
   - `FORENSICS_ENCRYPTION_KEY_PRIOR_1 = <was CURRENT>`
   - `FORENSICS_ENCRYPTION_KEY_ID_PRIOR_1 = <was ID_CURRENT>`
   - `FORENSICS_ENCRYPTION_KEY_CURRENT = <new key>`
   - `FORENSICS_ENCRYPTION_KEY_ID_CURRENT = forensics-v<N+1>`
3. **Boot guard** asserts `FORENSICS_ENCRYPTION_KEY_CURRENT !== APP_ENCRYPTION_KEY_CURRENT`. The new key must be distinct.
4. Redeploy. The decrypt path (`lib/forensics/decrypt.ts`) tries all three
   key IDs in order until it finds a match.

**Verification:**
- [ ] Run a synthetic forensics-decrypt against a snapshot from the previous
  rotation cycle and confirm it succeeds via the `_PRIOR_1` key.

---

### OAuth client secrets (§28.9, §28.10) — annual

**Microsoft Graph** (`MICROSOFT_GRAPH_CLIENT_SECRET`):
- Maximum 2-year lifetime per Azure policy; annual fits inside.
- In Azure portal → App Registrations → Certificates & secrets, generate
  a new secret.
- In Vercel:
  1. `MICROSOFT_GRAPH_CLIENT_SECRET_PREVIOUS = <current value>`
  2. `MICROSOFT_GRAPH_CLIENT_SECRET = <new value>`
- Redeploy.
- Code accepts both during the overlap window — Microsoft accepts whichever
  was registered.
- After 7 days, remove `_PREVIOUS` and revoke the old secret in Azure.

**Gmail OAuth** (`GMAIL_OAUTH_CLIENT_SECRET`):
- Same pattern with `_PREVIOUS` overlap. No enforced expiry by Google but
  rotate annually.

**Google / Facebook OAuth:**
- No enforced expiry. Annual rotation is discipline.

---

### Anthropic / OpenAI / Stripe — no regular cadence

Rotate on compromise or vendor-recommended cadence:

- **Anthropic** (`ANTHROPIC_API_KEY`): regenerate at console.anthropic.com.
  Replace in Vercel. Redeploy.
- **OpenAI** (`OPENAI_API_KEY`): regenerate at platform.openai.com. Replace
  in Vercel. Redeploy.
- **Stripe** (`STRIPE_SECRET_KEY`): rotate via Stripe dashboard. Webhook
  secrets (`STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`) rotate
  alongside endpoint creation. If swapping `sk_test_` ↔ `sk_live_`, see
  `docs/runbooks/stripe-price-ids.md` — every `STRIPE_PRICE_*` must also
  swap.

No overlap mechanism — each is a single-key rotation that briefly fails
in-flight requests during the redeploy.

---

### Supabase service-role keys — on compromise only

`SUPABASE_SERVICE_ROLE_KEY` rotation is high-friction (no overlap supported).
Only rotate on key compromise.

1. In Supabase dashboard → Settings → API, regenerate the service-role JWT.
2. In Vercel (main app), replace `SUPABASE_SERVICE_ROLE_KEY`. Redeploy.
3. All service-role-using paths (createServiceRoleClient, audit_log writes,
   forensics decrypt, etc.) immediately use the new key.

If you must, treat the gap as a brief incident — service-role writes will
fail for ~30 seconds between key regen and Vercel redeploy.

---

### `PLATFORM_PEPPER` — never rotate

`PLATFORM_PEPPER` is the secret salt that derives `anonymized_customer_hash`
on bookings, commissions, and contacts (§25). Rotating it orphans every
prior hash from its derived placeholder. **There is no migration path.**

If the pepper is compromised:
- File a key-compromise incident.
- Document it in MEMORY.
- Consult counsel before any retroactive action.

The pepper is stored in the 1Password vault entry `atc-platform-pepper`
with explicit "DO NOT ROTATE" documentation per D-058.

---

## Sign-off checklist (every rotation)

For each rotation, record in the operator log:

- [ ] **Date / operator** initiating the rotation
- [ ] **Secret class** being rotated
- [ ] **Pre-rotation state** captured (env var snapshot, redacted)
- [ ] **Staging rotation** completed and verified (where applicable)
- [ ] **Production rotation** steps executed in order
- [ ] **Post-rotation synthetic verification** completed and passing
- [ ] **Overlap window expired** + old values removed (where applicable)
- [ ] **Next rotation date** scheduled in the operator calendar (annual default)

---

## Annual rotation calendar template

| Month | Rotation |
|---|---|
| Jan | App encryption keys |
| Feb | Forensics encryption keys (offset to spread risk) |
| Mar | (verification cycle) Quarterly backup-verification + update `APP_ENCRYPTION_BACKUP_VERIFIED_AT` |
| Apr | Inter-service JWT keys |
| Jun | (verification cycle) Quarterly backup-verification |
| Jul | OAuth — Microsoft, Google, Facebook |
| Sep | (verification cycle) Quarterly backup-verification |
| Dec | (verification cycle) Quarterly backup-verification |

The exact dates are operator-set in the platform calendar. Adjust the
calendar to avoid landing rotations on weekends or planned freeze windows.
