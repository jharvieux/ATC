// §16.3.4 — Annual reminder cron for the reserved parent domain audit.
// Runs January 1 each year at 09:00 UTC. Emits a structured warning the
// operator must acknowledge per docs/runbooks/crown-jewel-annual-audit.md.

import { inngest } from "./client";

export const crownJewelAnnualAudit = inngest.createFunction(
  {
    id: "crown-jewel-annual-audit",
    triggers: [{ cron: "0 9 1 1 *" }],
  },
  async () => {
    const reservedDomain = process.env.RESERVED_PARENT_DOMAIN ?? "tenants.ai-travelconcierge.com";
    const projectId = process.env.VERCEL_PROJECT_ID ?? "<unset>";
    const platformEnv = process.env.PLATFORM_ENV ?? "<unset>";

    const message =
      `[crown-jewel-annual-audit] ANNUAL OPERATOR ACTION REQUIRED.\n` +
      `Reserved parent domain: ${reservedDomain}\n` +
      `Production Vercel project ID: ${projectId}\n` +
      `PLATFORM_ENV: ${platformEnv}\n\n` +
      `Operator: verify that ${reservedDomain} is bound to the production Vercel project ` +
      `(${projectId}) and to no other project. See docs/runbooks/crown-jewel-annual-audit.md.`;

    console.warn(message);
    // TODO(notifications): send email to platform operator via Resend with the runbook link.

    return { reservedDomain, projectId, platformEnv, audited_at: new Date().toISOString() };
  },
);
