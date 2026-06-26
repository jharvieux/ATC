"use client";

// §12 — CRM contacts list with search + pipeline filter.

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  pipeline_stage_key: string | null;
  date_of_birth_is_estimated: boolean | null;
}

interface ContactsResponse {
  contacts: Contact[];
  total: number;
}

export function ContactsView() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (pipelineFilter) params.set("pipeline_stage_key", pipelineFilter);
    try {
      const res = await fetch(`/api/crm/contacts?${params}`);
      if (!res.ok) return;
      const data: ContactsResponse = await res.json();
      setContacts(data.contacts ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [search, pipelineFilter]);

  useEffect(() => {
    void fetchContacts();
  }, [fetchContacts]);

  const displayName = (c: Contact) =>
    [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <Link
          href="/crm/contacts/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          Add contact
        </Link>
      </div>

      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Search name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm"
        />
        <select
          value={pipelineFilter}
          onChange={(e) => setPipelineFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="">All stages</option>
          <option value="lead">Lead</option>
          <option value="qualified">Qualified</option>
          <option value="quote_sent">Quote Sent</option>
          <option value="quote_accepted">Quote Accepted</option>
          <option value="booked">Booked</option>
          <option value="sailed">Sailed</option>
          <option value="lost">Lost</option>
          <option value="post_trip_followup">Post-Trip Follow-up</option>
        </select>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-3">{total} contact{total !== 1 ? "s" : ""}</p>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Email</th>
                  <th className="text-left px-4 py-3">Phone</th>
                  <th className="text-left px-4 py-3">Stage</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <a href={`/crm/contacts/${c.id}`} className="text-blue-600 hover:underline">
                        {displayName(c)}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{c.email ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-600">{c.phone ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-500">{c.pipeline_stage_key ?? "—"}</td>
                  </tr>
                ))}
                {contacts.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                      No contacts found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
