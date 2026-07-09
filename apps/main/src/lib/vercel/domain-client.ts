// §16.3 / §16.3.4 — Vercel API client for custom-domain binding.
//
// All calls go through assertProductionEnvForCrownJewel() — the second of three
// crown-jewel-domain guard layers (the first is at boot in env.ts; the third
// is the annual operator audit in inngest/crown-jewel-annual-audit.ts).

import "server-only";

export class VercelApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Vercel API ${status}: ${body}`);
    this.name = "VercelApiError";
  }
}

export class CrownJewelGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrownJewelGuardError";
  }
}

function assertProductionEnvForCrownJewel(): void {
  const platformEnv = process.env.PLATFORM_ENV ?? "development";
  if (platformEnv !== "production") {
    // §16.3.4 — refuse to call Vercel from non-production. This catches the
    // case where a staging deploy somehow has a VERCEL_API_TOKEN: still
    // refuse. The boot guard catches PLATFORM_PARENT_DOMAIN misconfig; this
    // catches "we have the token but we're not production".
    throw new CrownJewelGuardError(
      `[crown-jewel-guard] Vercel domain binding called from PLATFORM_ENV='${platformEnv}'. ` +
        `Only production may bind custom domains. Refusing call (§16.3.4).`,
    );
  }
}

function buildVercelUrl(path: string): string {
  const teamId = process.env.VERCEL_TEAM_ID;
  return teamId ? `https://api.vercel.com${path}?teamId=${teamId}` : `https://api.vercel.com${path}`;
}

function vercelHeaders(): Record<string, string> {
  const token = process.env.VERCEL_API_TOKEN;
  if (!token) throw new Error("VERCEL_API_TOKEN not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Bind a custom domain to the configured Vercel project.
 * Per §16.3.1 — called only after both DNS checks pass.
 */
export async function vercelAddDomain(customDomain: string): Promise<{ verified: boolean }> {
  assertProductionEnvForCrownJewel();
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) throw new Error("VERCEL_PROJECT_ID not configured");

  const url = buildVercelUrl(`/v10/projects/${projectId}/domains`);
  const res = await fetch(url, {
    method: "POST",
    headers: vercelHeaders(),
    body: JSON.stringify({ name: customDomain }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new VercelApiError(res.status, text);
  }

  const body = await res.json() as { verified?: boolean };
  return { verified: body.verified ?? false };
}

/**
 * Remove a custom domain binding. Per §16.3.3 — idempotent: 404 is success.
 */
export async function vercelRemoveDomain(customDomain: string): Promise<{ removed: boolean }> {
  assertProductionEnvForCrownJewel();
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) throw new Error("VERCEL_PROJECT_ID not configured");

  const url = buildVercelUrl(`/v9/projects/${projectId}/domains/${encodeURIComponent(customDomain)}`);
  const res = await fetch(url, {
    method: "DELETE",
    headers: vercelHeaders(),
  });

  if (res.status === 404) {
    // Already removed — idempotent success.
    return { removed: true };
  }
  if (!res.ok) {
    const text = await res.text();
    throw new VercelApiError(res.status, text);
  }
  return { removed: true };
}
