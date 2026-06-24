"use client";

// §18 — Group bookings list page. Staff-only via sidebarSectionsForRole
// (Workspace section). Fetches GET /api/groups (groups:list permission).

import Link from "next/link";
import { useState, useEffect } from "react";

interface GroupRow {
  id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  departure_port: string | null;
  created_at: string;
  cruise_lines: { display_name: string } | null;
}

function statusColor(status: string): string {
  switch (status) {
    case "active":   return "bg-green-100 text-green-800";
    case "planning": return "bg-amber-100 text-amber-800";
    case "closed":   return "bg-gray-100 text-gray-600";
    case "cancelled":return "bg-red-100 text-red-800";
    default:         return "bg-gray-100 text-gray-700";
  }
}

export default function GroupBookingsPage() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/groups")
      .then(async (res) => {
        if (!res.ok) { setError("Failed to load group bookings"); return; }
        const data: { groups: GroupRow[] } = await res.json();
        setGroups(data.groups ?? []);
      })
      .catch(() => setError("Failed to load group bookings"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Group Bookings</h1>
        <Link
          href="/groups/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          New group
        </Link>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : error ? (
        <div className="text-red-600 text-sm">{error}</div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Cruise / Ship</th>
                <th className="text-left px-4 py-3 font-medium">Sailing date</th>
                <th className="text-left px-4 py-3 font-medium">Departure</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No group bookings yet.{" "}
                    <Link href="/groups/new" className="text-blue-600 hover:underline">
                      Create your first group.
                    </Link>
                  </td>
                </tr>
              ) : (
                groups.map((g) => {
                  const cruiseName = g.cruise_lines?.display_name ?? g.cruise_line ?? "—";
                  return (
                    <tr key={g.id} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/groups/${g.id}/coordinate/overview`}
                          className="text-blue-600 hover:underline"
                        >
                          {cruiseName}{g.ship_name ? ` — ${g.ship_name}` : ""}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{g.sailing_date ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-700">{g.departure_port ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColor(g.status)}`}>
                          {g.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {new Date(g.created_at).toLocaleDateString("en-US")}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
