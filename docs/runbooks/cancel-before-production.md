# Cancel Before Production

## When to use this runbook

Use this runbook when a release pipeline has completed staging successfully and is now **paused at the production approval gate** — but you have decided not to proceed. This is the right choice when staging E2E tests passed but a last-minute issue was found (a manual QA finding, a bad monitoring signal, a stakeholder hold), and you want to stop the deployment before it reaches production users. Staging retains the new code for continued debugging; nothing is deployed to production.

## Prerequisites

- Access to the GitHub repository with Actions write permission (to review/reject deployments)
- The release branch name (e.g. `release/0.3.1`)
- The pipeline must currently be in the **waiting for approval** state — the workflow run will be paused with a yellow pending indicator

## Steps

1. **Open the pending workflow run**

   Go to **GitHub → Actions → All workflows**. Find the workflow run for the release branch. Its status will show a yellow pending indicator: "Waiting for review."

   [SCREENSHOT: github-actions-pending-workflow]

2. **Open the Review Deployments panel**

   Click into the workflow run. In the job list on the left, find the **production-deploy** job — it will show a clock icon and the label "Waiting for approval."

   Click **Review deployments** (the yellow button in the job panel or in the workflow summary banner).

   [SCREENSHOT: github-actions-review-deployments]

3. **Reject the deployment**

   In the review panel:
   - The `production` environment will be listed with a checkbox
   - Add a comment explaining why you are rejecting (e.g. "Holding for QA finding in booking flow — will re-deploy once fixed")
   - Click **Reject**

   The workflow run will immediately transition to **failed/cancelled** state. No code is deployed to production.

   [SCREENSHOT: github-actions-reject-deployment]

4. **Confirm staging is unaffected**

   Staging still has the new code. You can continue debugging against `dev.ai-travelconcierge.com`. The rejection only stops the production step; it does not roll back staging.

## Verification

The cancellation is confirmed when:

- The workflow run shows status **Failed** or **Cancelled** in GitHub Actions
- `https://ai-travelconcierge.com/api/health` still returns the version from the previous production deployment (not the new one)
- `https://dev.ai-travelconcierge.com/api/health` returns the new version (staging is intact)

Check current production version:

```bash
curl -s https://ai-travelconcierge.com/api/health | jq '.version'
```

## Post-incident

1. **Diagnose the issue on staging.** Staging has the new code; reproduce and fix there.

2. **Push fixes to the release branch.** A new push to `release/0.3.1` re-triggers the full pipeline from the beginning (CI → DB copy → staging deploy → E2E → approval gate). You will get a fresh approval opportunity once staging is green again.

   ```bash
   git checkout release/0.3.1
   git pull origin release/0.3.1
   # apply fix commits
   git push origin release/0.3.1
   ```

3. **Do not create a new release branch** for the same version. Fix on the existing branch and let the pipeline retry.

4. If the issue is severe enough that the release should be abandoned entirely, close the release branch and open a new one from a fixed `dev` once the root cause is resolved.
