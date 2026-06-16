// Returns the host_agency_legal_name from platform_settings.
// Used by the state-of-operation onboarding page notice.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function GET(): Promise<Response> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "host_agency_legal_name")
    .maybeSingle();

  if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

  const name = data?.value ? String(data.value).replace(/^"|"$/g, "") : null;
  return Response.json({ name });
}
