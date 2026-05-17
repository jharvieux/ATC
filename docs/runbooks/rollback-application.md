# Rollback Application

## When to use this runbook

Use this runbook when a production deployment has introduced a critical regression — broken functionality, elevated error rates, failed health checks — and you need to restore service immediately by reverting to the previous known-good deployment. This is the fastest path to recovery: Vercel retains all prior deployments and can promote any of them to production in seconds without a code push or pipeline run.

## Prerequisites

- Access to the Vercel Dashboard for the `ai-travelconcierge` project (owner or member role with deployment permissions)
- The git tag of the last known-good release (e.g. `v0.3.1`) — check `git tag --sort=-v:refname | head -5` if unsure
- `curl` available locally for the verification step

## Steps

1. **Open the Vercel Dashboard**

   Navigate to [vercel.com/dashboard](https://vercel.com/dashboard) and select the **ai-travelconcierge** project.

   [SCREENSHOT: vercel-dashboard-project-select]

2. **Open the Deployments list**

   Click **Deployments** in the left sidebar. You will see all deployments sorted by date, newest first. The current production deployment is marked with a green **Production** badge.

   [SCREENSHOT: vercel-deployments-list]

3. **Identify the last known-good deployment**

   Use the git tag as your reference. Each deployment row shows the git commit SHA and commit message. Find the deployment whose SHA matches the commit tagged as the last good release:

   ```bash
   # Run locally to find the SHA for a tag
   git rev-list -n 1 v0.3.1
   ```

   Match that SHA to a deployment row in the list.

   [SCREENSHOT: vercel-deployments-sha-column]

4. **Promote to Production**

   Click the **⋮** (three-dot) menu on the target deployment row, then click **Promote to Production**.

   Vercel will confirm: "Promote this deployment to production?" — click **Promote**.

   Traffic shifts immediately. No build is triggered. The old production deployment is demoted to a regular preview URL.

   [SCREENSHOT: vercel-promote-to-production]

5. **Verify the rollback**

   Wait approximately 30 seconds, then run:

   ```bash
   curl -s https://ai-travelconcierge.com/api/health | jq .
   ```

   Expected response shape:

   ```json
   {
     "status": "ok",
     "timestamp": "2026-05-16T10:00:00.000Z",
     "version": "<sha-of-rolled-back-deployment>",
     "checks": {
       "supabase": "ok"
     }
   }
   ```

   Confirm:
   - `status` is `"ok"`
   - `version` matches the SHA of the deployment you promoted
   - `checks.supabase` is `"ok"`

   Also run the production version check script:

   ```bash
   bash scripts/check-production-version.sh
   ```

## Verification

The rollback is confirmed when:

- `/api/health` returns HTTP 200 with `status: "ok"`
- `version` in the health response matches the rolled-back deployment SHA
- Any user-facing symptom that triggered the rollback is no longer reproducible

## Post-incident

1. **Open a bug report** in GitHub Issues describing the regression: what broke, when it was introduced, what the user impact was.

2. **Do NOT re-push to the failed release branch.** That branch is tainted. Create a new feature branch from `dev`:

   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/fix-<short-description>
   ```

3. Apply the fix on the new branch and follow the normal PR → CI → release branch → pipeline path.

4. Tag the fix release with the next version number (`v0.3.2`, etc.). The pipeline creates the tag automatically on a successful production deploy.

5. Update the incident log in GitHub Issues with the resolution and a link to the fix PR.
