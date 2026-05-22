# Crown-Jewel Annual Audit: Reserved Parent Domain

**Purpose:** Confirm that `tenants.ai-travelconcierge.com` (the reserved parent
domain, §16.3.4) is bound to **exactly** the production Vercel project and is
NOT bound to any staging, preview, or experimental Vercel project.

**Cadence:** Annually, on January 1. Triggered by the
`crown-jewel-annual-audit` Inngest cron, which emits a `console.warn` with the
configured `RESERVED_PARENT_DOMAIN` and `VERCEL_PROJECT_ID`.

**Why this matters:** If the reserved parent domain is ever bound to a
non-production Vercel project — even briefly — every active custom-domain
tenant's traffic routes to that project for the duration of the misbinding.
This is a configuration vulnerability that no amount of careful code can
catch; the only mitigation is operational discipline.

---

## Steps

### 1. Confirm the production binding

```bash
# Replace <prod-project-id> with VERCEL_PROJECT_ID and <token> with VERCEL_API_TOKEN
curl -s https://api.vercel.com/v9/projects/<prod-project-id>/domains \
  -H "Authorization: Bearer <token>" \
  | jq '.domains[] | select(.name == "tenants.ai-travelconcierge.com")'
```

You should see exactly one entry, verified, with `verified: true` and no
`error`. If the entry is missing → tenants without working DNS; if the entry
exists but `verified: false` → re-verify in Vercel UI.

### 2. Confirm no other project has it bound

Visit https://vercel.com/<team>/settings/domains and search for
`tenants.ai-travelconcierge.com`. Only the production project should appear.

If any other project has it bound (staging, preview, an experimental project):
**STOP**. Document the project name, request its owner to release the binding,
then re-run Step 1 to confirm production is still bound. The release may have
temporarily broken tenant traffic; if so, re-bind to production immediately.

### 3. Verify boot guard is active

The boot guard in `apps/main/src/lib/env.ts` refuses to start any non-production
process where `PLATFORM_PARENT_DOMAIN === RESERVED_PARENT_DOMAIN`. Confirm:

```bash
# In staging:
PLATFORM_ENV=staging PLATFORM_PARENT_DOMAIN=tenants.ai-travelconcierge.com node -e "require('./apps/main/src/lib/env').verifyEnvAtBoot()"
# Expected output: throw with [crown-jewel-guard] error
```

### 4. Confirm `assertProductionEnvForCrownJewel` is wired

The Vercel API client (`apps/main/src/lib/vercel/domain-client.ts`) asserts
production before any `vercelAddDomain` / `vercelRemoveDomain` call. The unit
tests in `apps/main/test/unit/vercel/domain-client.test.ts` cover this; ensure
they all pass.

### 5. Sign off

After confirming Steps 1–4 are green, record the audit in MEMORY.md with the
date and your name as auditor. The cron will fire again in 12 months.

---

## Failure mode

If during the audit you discover the reserved domain is bound to a
non-production project AND tenants have experienced misrouted traffic during
the period, the incident is **§26 severity-1**: open a postmortem, alert any
affected tenants per §17 incident-notification rules, and revise the
operational checklist that allowed the misbinding to happen.
