"use client";

// §12 — Contact detail: timeline + relationship graph + DOB display rules (§11.5).

import { useState, useEffect, use } from "react";
import { formatDate } from "@/lib/format-date";
import { dobDisplayLabel } from "@/lib/contacts/dob-display";
import { RelationshipsPanel } from "@/components/crm/RelationshipsPanel";

// #1728 — deep-link the draft composer with the inbound reply pre-filled.
// Draft-only: this is a link to the §904 composer, which has no send path.
function draftReplyHref(body: string, firstName: string | null): string {
  const params = new URLSearchParams({ inquiry: body });
  if (firstName) params.set("customerName", firstName);
  return `/concierge/draft?${params.toString()}`;
}

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  date_of_birth_is_estimated: boolean | null;
  pipeline_stage_key: string | null;
  nationality: string | null;
  passport_expiry: string | null;
}

interface TimelineItem {
  type: "conversation" | "quote" | "booking" | "email";
  id: string;
  created_at: string;
  status?: string;
  content?: string;
  [key: string]: unknown;
}

export default function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [contact, setContact] = useState<Contact | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [cRes, tRes] = await Promise.all([
          fetch(`/api/crm/contacts/${id}`),
          fetch(`/api/crm/contacts/${id}/timeline`),
        ]);
        if (!cRes.ok) { setError("Contact not found"); return; }
        const cData: Contact = await cRes.json();
        setContact(cData);
        if (tRes.ok) {
          const tData: { timeline: TimelineItem[] } = await tRes.json();
          setTimeline(tData.timeline ?? []);
        }
      } catch {
        setError("Failed to load contact");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [id]);

  if (loading) return <div className="p-8 text-center">Loading…</div>;
  if (error || !contact) return <div className="p-8 text-center text-red-600">{error ?? "Not found"}</div>;

  const dobLabel = dobDisplayLabel({
    date_of_birth: contact.date_of_birth,
    date_of_birth_is_estimated: contact.date_of_birth_is_estimated,
  });

  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(no name)";

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{fullName}</h1>
        {contact.pipeline_stage_key && (
          <span className="inline-block mt-1 text-sm bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
            {contact.pipeline_stage_key}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6 mb-8">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-500 mb-3">Contact info</h2>
          <dl className="space-y-2 text-sm">
            <div><dt className="text-gray-500">Email</dt><dd>{contact.email ?? "—"}</dd></div>
            <div><dt className="text-gray-500">Phone</dt><dd>{contact.phone ?? "—"}</dd></div>
            <div>
              <dt className="text-gray-500">Date of birth</dt>
              <dd>
                {dobLabel ?? "—"}
                {contact.date_of_birth_is_estimated && (
                  <button className="ml-2 text-xs text-blue-600 underline">Edit</button>
                )}
              </dd>
            </div>
            <div><dt className="text-gray-500">Nationality</dt><dd>{contact.nationality ?? "—"}</dd></div>
            <div><dt className="text-gray-500">Passport expiry</dt><dd>{contact.passport_expiry ?? "—"}</dd></div>
          </dl>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-500 mb-3">Relationships</h2>
          <RelationshipsPanel contactId={id} />
        </div>
      </div>

      <div>
        <h2 className="text-lg font-medium mb-3">Timeline</h2>
        {timeline.length === 0 ? (
          <p className="text-sm text-gray-400">No activity yet.</p>
        ) : (
          <ul className="space-y-2">
            {timeline.map((item) => (
              <li key={`${item.type}-${item.id}`} className="flex gap-3 text-sm">
                <span className="text-gray-400 w-24 shrink-0">
                  {formatDate(item.created_at)}
                </span>
                {item.type === "email" ? (
                  <>
                    <span className="text-blue-600">Email reply</span>
                    <span className="text-gray-500 truncate max-w-sm">
                      {item.content ?? ""}
                    </span>
                    <a
                      href={draftReplyHref(item.content ?? "", contact.first_name)}
                      className="ml-auto text-blue-600 underline whitespace-nowrap"
                    >
                      Draft reply
                    </a>
                  </>
                ) : (
                  <>
                    <span className="capitalize text-blue-600">{item.type}</span>
                    <span className="text-gray-500">{item.status ?? ""}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
