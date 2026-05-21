// Spec ref: §1.4 (tenant resolution), §3.6 (resolution logic), BP04
//
// Runtime: Next.js edge runtime locally; Vercel deploys this under Fluid
// Compute (Node.js). @supabase/supabase-js v2 is edge-compatible so no
// explicit `runtime = 'nodejs'` is needed. See MEMORY.md D-037 for rationale.

import { NextRequest, NextResponse } from "next/server";
import {
  getTenantBySlug,
  getTenantByCustomDomain,
} from "@/lib/tenancy/resolve-tenant";

const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";
const RESOLVED_TENANT_TYPE_HEADER = "x-resolved-tenant-type";

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const host = req.headers.get("host") ?? "";
  // Strip port for local dev comparisons.
  const hostname = host.replace(/:\d+$/, "");

  const primaryDomain = process.env.PLATFORM_PRIMARY_DOMAIN ?? "";
  const domainRegex = process.env.PLATFORM_DOMAIN_REGEX ?? "";

  // 1. Platform admin domain — passes through with "platform" sentinel.
  if (hostname === primaryDomain) {
    const res = NextResponse.next();
    res.headers.set(RESOLVED_TENANT_ID_HEADER, "platform");
    res.headers.set(RESOLVED_TENANT_TYPE_HEADER, "platform");
    return res;
  }

  // 2. Subdomain of the platform primary domain — resolve by slug.
  if (domainRegex) {
    const match = hostname.match(new RegExp(domainRegex));
    const slug = match?.[1];
    if (match && slug) {
      try {
        const tenant = await getTenantBySlug(slug);
        if (tenant) {
          const res = NextResponse.next();
          res.headers.set(RESOLVED_TENANT_ID_HEADER, tenant.id);
          res.headers.set(RESOLVED_TENANT_TYPE_HEADER, tenant.tenant_type);
          return res;
        }
      } catch {
        // DB error — fall through to 404. Don't leak DB error details.
      }
      return notFound();
    }
  }

  // 3. Custom domain — resolve by full hostname.
  try {
    const tenant = await getTenantByCustomDomain(hostname);
    if (tenant) {
      const res = NextResponse.next();
      res.headers.set(RESOLVED_TENANT_ID_HEADER, tenant.id);
      res.headers.set(RESOLVED_TENANT_TYPE_HEADER, tenant.tenant_type);
      return res;
    }
  } catch {
    // DB error — fall through to 404.
  }

  return notFound();
}

function notFound(): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><title>Site not found</title></head><body>` +
      `<h1>This site is not currently active.</h1>` +
      `<p>If you believe this is an error, please contact support.</p>` +
      `</body></html>`,
    {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

export const config = {
  // Run on all paths except Next.js internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
