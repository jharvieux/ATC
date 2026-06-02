// §7.6 — Booking list (GET) for the tenant CRM bookings page.
//
// Paginated + status-filtered. Tenant-scoped via tenantClient. Joins the
// primary contact's display name so the list page doesn't need a second
// round-trip per row.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { escapeIlikeOrTerm } from "@/lib/db/postgrest-filter";
import { respondToAuthError } from "@/lib/auth/respond";
import { fromCents, type Cents } from "@/lib/money";

const QuerySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(25),
  contact_query: z.string().optional(),
});

const PAGE_SIZE_DEFAULT = 25;

interface BookingRow {
  id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  total_amount_cents: number | bigint | null;
  currency: string | null;
  primary_contact_id: string | null;
  is_test: boolean | null;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    page_size: url.searchParams.get("page_size") ?? undefined,
    contact_query: url.searchParams.get("contact_query") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_query", detail: parsed.error.message },
      { status: 400 },
    );
  }
  const { status, page, page_size, contact_query } = parsed.data;
  const from = (page - 1) * page_size;
  const to = from + page_size - 1;

  const db = tenantClient(auth.ctx);

  // If contact_query is set, first find matching contact IDs (fuzzy name / email).
  let contactIds: string[] | null = null;
  if (contact_query && contact_query.trim().length >= 2) {
    const q = escapeIlikeOrTerm(contact_query);
    const { data: matches, error: matchErr } = await db
      .from("contacts")
      .select("id")
      .or(`first_name.ilike.${q},last_name.ilike.${q},email.ilike.${q}`)
      .limit(200);
    if (matchErr) {
      return Response.json(
        { error: "lookup_failed", detail: matchErr.message },
        { status: 500 },
      );
    }
    contactIds = ((matches ?? []) as Array<{ id: string }>).map((m) => m.id);
    if (contactIds.length === 0) {
      return Response.json({ bookings: [], total: 0, page, page_size });
    }
  }

  let query = db
    .from("bookings")
    .select(
      "id, status, cruise_line, ship_name, sailing_date, duration_nights, total_amount_cents, currency, primary_contact_id, is_test, created_at, updated_at",
      { count: "exact" },
    )
    .order("updated_at", { ascending: false })
    .range(from, to);

  if (status) query = query.eq("status", status);
  if (contactIds) query = query.in("primary_contact_id", contactIds);

  const { data: rows, error: queryErr, count } = await query;
  if (queryErr) {
    return Response.json(
      { error: "lookup_failed", detail: queryErr.message },
      { status: 500 },
    );
  }
  const bookings = (rows ?? []) as BookingRow[];

  // Resolve primary contacts in one round-trip.
  const uniqueContactIds = Array.from(
    new Set(bookings.map((b) => b.primary_contact_id).filter((id): id is string => id !== null)),
  );
  let contactsById = new Map<string, ContactRow>();
  if (uniqueContactIds.length > 0) {
    const { data: contactRows, error: contactErr } = await db
      .from("contacts")
      .select("id, first_name, last_name, email")
      .in("id", uniqueContactIds);
    if (contactErr) {
      return Response.json(
        { error: "lookup_failed", detail: contactErr.message },
        { status: 500 },
      );
    }
    contactsById = new Map(
      ((contactRows ?? []) as ContactRow[]).map((c) => [c.id, c]),
    );
  }

  return Response.json({
    bookings: bookings.map((b) => ({
      id: b.id,
      status: b.status,
      cruise_line: b.cruise_line,
      ship_name: b.ship_name,
      sailing_date: b.sailing_date,
      duration_nights: b.duration_nights,
      total_amount:
        b.total_amount_cents === null
          ? null
          : fromCents(BigInt(b.total_amount_cents) as Cents),
      currency: b.currency,
      is_test: b.is_test ?? false,
      primary_contact: b.primary_contact_id
        ? contactsById.get(b.primary_contact_id) ?? null
        : null,
      created_at: b.created_at,
      updated_at: b.updated_at,
    })),
    total: count ?? 0,
    page,
    page_size: page_size ?? PAGE_SIZE_DEFAULT,
  });
}
