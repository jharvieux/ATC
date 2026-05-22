/** Spec ref: §9 — Chunk ingestion (lands in BP09) */

import { withServiceAuth } from "@/lib/auth/with-service-auth";

export const POST = withServiceAuth(async (_req, _ctx) => {
  return Response.json({ todo: "Chunk ingestion", spec_section: "§9" }, { status: 501 });
});
