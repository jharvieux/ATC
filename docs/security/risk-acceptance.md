# CVE Risk Acceptance Process

## Overview

The CI pipeline runs `npm audit` on every PR and push. Critical CVEs fail the build. High CVEs produce a warning annotation. Low and moderate findings are informational only.

If a high-severity CVE cannot be fixed (no patch available, breaking upgrade, false positive), it can be formally suppressed by following this process.

## When to Suppress vs. Fix

Suppress only when:

- No patched version exists yet, OR
- The upgrade is breaking and the risk of the upgrade outweighs the CVE risk, OR
- The CVE affects a code path this project does not use (document this explicitly)

Always prefer fixing over suppressing.

## Suppression Process

1. **Open a PR** adding a YAML entry to `docs/security/cve-suppressions.md`:

   ```yaml
   cve_id: CVE-YYYY-NNNNN
   package: package-name@version-range
   reason: >
     Detailed explanation of why this CVE does not apply to our usage.
     Include the affected code path and why we don't hit it.
   expires_at: YYYY-MM-DD
   ```

2. **Required fields:**
   - `cve_id` — the CVE identifier (link to NVD or GitHub Advisory)
   - `package` — affected package and version range
   - `reason` — why the CVE doesn't apply to this project's usage
   - `expires_at` — max 90 days from PR approval date

3. **PR approval:** requires a security reviewer (defined in CODEOWNERS).

4. **After merge:** the `cve-scan` CI job reads `cve-suppressions.md` and excludes matching CVE IDs from the high-severity warning step.

## Suppression Expiry

Suppressions expire at `expires_at`. Expired suppressions must be renewed or removed. A quarterly review of `cve-suppressions.md` removes entries that have expired or whose CVE has been patched.

## Critical CVE Policy

Critical CVEs cannot be suppressed via this process. They block the build unconditionally. Escalate to the engineering lead immediately.
