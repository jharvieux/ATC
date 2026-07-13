// Returns the host_agency_legal_name from platform_settings.
// Used by the state-of-operation onboarding page notice.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { resolveHostAgencyLegalName } from "@/lib/platform/platform-setting-cache";

export async function GET(): Promise<Response> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "host_agency_legal_name")
    .maybeSingle();

  if (error) return dbErrorResponse(error);

  // #1877 — unified onto the canonical unwrap. The old regex quote-stripping
  // handled only a bare-string shape (and mangled the {value:…} shape to
  // "[object Object]"); the shared helper handles both wire shapes and returns
  // null on a missing/malformed value, matching the §20.7 disclosure readers.
  const name = resolveHostAgencyLegalName((data as { value?: unknown } | null)?.value);
  return Response.json({ name });
}
