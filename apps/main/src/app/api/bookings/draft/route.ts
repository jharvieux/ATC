// §7.6 / §20.2 — Create draft booking.
//
// POST /api/bookings/draft  { primary_contact_id?: string }
//
// Entry point for the platform-native fallback booking flow at
// /booking/flow/[id]/[stage]. The page assumes the row already exists
// (it PATCHes per-stage fields); this is the upstream call that creates
// the row in status='draft' so the page has an id to navigate to.
//
// Validation:
//   - primary_contact_id is OPTIONAL — agents create blank drafts and
//     bind a contact later. When provided, RLS on `contacts` enforces
//     same-tenant ownership: if the caller tries to bind a contact from
//     a different tenant, the SELECT below returns no row and we 422.
//     Belt + suspenders alongside the contacts.tenant_id FK.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwaitRequired } from "@/lib/db/safe-mutation";

const BodySchema = z
  .object({
    primary_contact_id: z.string().uuid().optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "bookings",
      action: "create",
    });

    const body: unknown = await req.json().catch(() => ({}));
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const { primary_contact_id } = parsed.data;

    const db = tenantClient(ctx);

    if (primary_contact_id) {
      const { data: contact, error: contactErr } = await db
        .from("contacts")
        .select("id")
        .eq("id", primary_contact_id)
        .maybeSingle();
      if (contactErr) {
        return Response.json(
          { error: "contact_lookup_failed" },
          { status: 500 },
        );
      }
      if (!contact) {
        // Either the contact does not exist or it belongs to a different
        // tenant (RLS hid it). Same response either way — don't leak
        // cross-tenant existence.
        return Response.json({ error: "contact_not_found" }, { status: 422 });
      }
    }

    // status='draft' and the created/updated timestamps default at the DB.
    // tenantClient injects tenant_id on insert; we don't double-write it
    // here so a future tenant_id rename only has to change one place.
    const insertRow: Record<string, unknown> = {};
    if (primary_contact_id) {
      insertRow.primary_contact_id = primary_contact_id;
    }

    const row = await safeAwaitRequired<{ id: string }>(
      db.from("bookings").insert(insertRow).select("id").single(),
      "bookings.draft.insert",
    );

    return Response.json({ id: row.id }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
