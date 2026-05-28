"use client";

// §7.6 — Tenant CRM bookings list.

import Link from "next/link";
import { useEffect, useState } from "react";

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

interface BookingRow {
  id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  total_amount: string | null;
  currency: string | null;
  is_test: boolean;
  primary_contact: Contact | null;
  created_at: string;
  updated_at: string;
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "submitting", label: "Submitting" },
  { value: "pending_host_review", label: "Pending review" },
  { value: "submitted", label: "Submitted" },
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
];

function statusColor(status: string): string {
  switch (status) {
    case "draft":
      return "bg-gray-100 text-gray-700";
    case "submitting":
    case "pending_host_review":
      return "bg-amber-100 text-amber-800";
    case "submitted":
    case "confirmed":
      return "bg-green-100 text-green-800";
    case "cancelled":
    case "failed":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function contactName(c: Contact | null): string {
  if (!c) return "—";
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || c.email || "—";
}

function money(amount: string | null, currency: string | null): string {
  if (amount === null) return "—";
  return `${currency ?? "USD"} ${amount}`;
}

export default function BookingsListPage() {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [status, setStatus] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/bookings", window.location.origin);
        url.searchParams.set("page", String(page));
        url.searchParams.set("page_size", String(pageSize));
        if (status) url.searchParams.set("status", status);
        if (contactQuery.trim().length >= 2) {
          url.searchParams.set("contact_query", contactQuery.trim());
        }
        const res = await fetch(url.toString());
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setError(err.error ?? `status_${res.status}`);
          return;
        }
        const data = (await res.json()) as { bookings: BookingRow[]; total: number };
        if (!cancelled) {
          setBookings(data.bookings);
          setTotal(data.total);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, pageSize, status, contactQuery]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Bookings</h1>
        <span className="text-sm text-gray-500">{total} total</span>
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm">
          <span className="sr-only">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="border border-gray-300 rounded px-2 py-1 text-sm"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          value={contactQuery}
          onChange={(e) => {
            setContactQuery(e.target.value);
            setPage(1);
          }}
          placeholder="Search customer name or email…"
          className="border border-gray-300 rounded px-3 py-1 text-sm flex-1 min-w-[220px]"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Cruise</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Sail date</th>
              <th className="px-4 py-2 font-medium">Total</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : bookings.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-gray-500" colSpan={6}>
                  No bookings match these filters.
                </td>
              </tr>
            ) : (
              bookings.map((b) => (
                <tr key={b.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/crm/bookings/${b.id}`} className="text-blue-700 hover:underline">
                      {b.cruise_line ?? "—"} {b.ship_name ?? ""}
                    </Link>
                    {b.is_test && (
                      <span className="ml-2 inline-flex items-center rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-800">
                        test
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{contactName(b.primary_contact)}</td>
                  <td className="px-4 py-2 text-gray-700">{b.sailing_date ?? "—"}</td>
                  <td className="px-4 py-2 text-gray-900">{money(b.total_amount, b.currency)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColor(b.status)}`}
                    >
                      {b.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 text-xs">
                    {new Date(b.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1 text-sm border border-gray-300 rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
