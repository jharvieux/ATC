// §12.1 — Contacts list + create.
// §35.7.1 — Contact creation must capture source attribution.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { recordIdentificationTouch } from "@/lib/attribution/record-touch";
import { readPendingAttributionFromHeader, ATTRIBUTION_PENDING_COOKIE } from "@/lib/attribution/read-pending-cookie";
import { channelFromManualCategory } from "@/lib/attribution/channel-map";
import { emptyAttributionPayload } from "@/lib/attribution/types";
import { respondToAuthError } from "@/lib/auth/respond";

const ContactCreateSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  middle_name: z.string().optional(),
  preferred_name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  date_of_birth: z.string().optional(),
  date_of_birth_is_estimated: z.boolean().optional(),
  estimation_basis: z.string().optional(),
  gender: z.string().optional(),
  nationality: z.string().optional(),
  passport_expiry: z.string().optional(),
  loyalty_programs: z.record(z.unknown()).optional(),
  dietary_restrictions: z.string().optional(),
  accessibility_needs: z.string().optional(),
  source: z.string().optional(),
  source_reference: z.string().optional(),
  pipeline_stage_key: z.string().optional(),
  user_id: z.string().uuid().optional(),
  // §35.7.1 — manual source (required at contact creation per spec; the
  // UI enforces requiredness, the API treats it as optional to preserve
  // existing callers and falls back to 'Other' if absent).
  attribution_manual_label: z.string().optional(),
  attribution_manual_category: z.string().optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "list" });
    const db = tenantClient(ctx);

    const url = new URL(req.url);
    const pipeline_stage_key = url.searchParams.get("pipeline_stage_key");
    const search = url.searchParams.get("search");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    let query = db.from("contacts").select("*", { count: "exact" });

    if (pipeline_stage_key) query = query.eq("pipeline_stage_key", pipeline_stage_key);
    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`,
      );
    }

    const { data, error, count } = await query
      .order("last_name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ contacts: data, total: count, limit, offset });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "contacts", action: "create" });
    const db = tenantClient(ctx);

    const body = await req.json();
    const parsed = ContactCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
    }

    // Pull attribution fields out of the schema's catch-all so they don't
    // get serialised into the contacts row directly.
    const { attribution_manual_label, attribution_manual_category, ...contactRow } = parsed.data;

    const { data, error } = await db
      .from("contacts")
      .insert({ ...contactRow, created_by_user_id: user.id })
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    // §35.4.3 — write a touch row for the freshly-created contact.
    // Manual entry path is source_origin='agent_set' with editor_user_id set.
    // Pending UTM cookie wins if present (the agent might be creating from
    // a UTM-bearing inbound link), otherwise we fall back to the manual
    // category. Per §35.7.1 manual source is required — UI enforces.
    const contactId = (data as { id: string }).id;
    const pending = readPendingAttributionFromHeader(req.headers.get("cookie"));
    const payload = pending
      ? pending
      : {
          ...emptyAttributionPayload(),
          manual_label: attribution_manual_label ?? null,
          manual_category: attribution_manual_category ?? null,
          channel: channelFromManualCategory(attribution_manual_category),
        };
    await recordIdentificationTouch(
      {
        tenant_id: ctx.tenant_id,
        contact_id: contactId,
        is_new_contact: true,
        source_origin: pending ? "utm_parsed" : "agent_set",
        editor_user_id: user.id,
        payload,
      },
      db,
    );

    const res = Response.json(data, { status: 201 });
    if (pending) res.headers.append("Set-Cookie", `${ATTRIBUTION_PENDING_COOKIE}=; Path=/; Max-Age=0`);
    return res;
  } catch (err) {
    return respondToAuthError(err);
  }
}
