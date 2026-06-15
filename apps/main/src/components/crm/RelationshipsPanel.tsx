"use client";

// §12.2 — Contact relationship panel.
// Lists relationships, adds new ones (canonical type + target contact ID),
// and removes them. Wired to GET/POST/DELETE /api/crm/contacts/[id]/relationships.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Canonical values from migration 20260524020000_contact_relationships.sql.
const RELATIONSHIP_TYPES = [
  "spouse",
  "partner",
  "parent_of",
  "child_of",
  "sibling",
  "friend",
  "colleague",
] as const;

interface Relationship {
  id: string;
  to_contact_id: string;
  relationship_type: string;
  notes: string | null;
  created_at: string;
}

export function RelationshipsPanel({ contactId }: { contactId: string }) {
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [adding, setAdding] = useState(false);
  const [toContactId, setToContactId] = useState("");
  const [relType, setRelType] = useState<string>(RELATIONSHIP_TYPES[0]);
  const [addError, setAddError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Remove state
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/contacts/${contactId}/relationships`);
      if (!res.ok) {
        setError(`Failed to load relationships (${res.status})`);
        return;
      }
      const data: { relationships: Relationship[] } = await res.json();
      setRelationships(data.relationships ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => { void load(); }, [load]);

  async function addRelationship() {
    setAddError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/crm/contacts/${contactId}/relationships`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to_contact_id: toContactId.trim(), relationship_type: relType }),
      });
      const data: { error?: string } = await res.json();
      if (!res.ok) {
        setAddError(data.error ?? `Error ${res.status}`);
        return;
      }
      setToContactId("");
      setRelType(RELATIONSHIP_TYPES[0]);
      setAdding(false);
      await load();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeRelationship(relId: string) {
    setRemoving(relId);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/crm/contacts/${contactId}/relationships/${relId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        const data: { error?: string } = await res.json();
        setRemoveError(data.error ?? `Error ${res.status}`);
        return;
      }
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setRemoving(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-gray-400">Loading relationships…</p>;
  }

  if (error) {
    return <p className="text-sm text-red-500">{error}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {removeError && (
        <p className="text-sm text-red-500">{removeError}</p>
      )}

      {relationships.length === 0 && !adding ? (
        <p className="text-sm text-gray-400">No relationships recorded.</p>
      ) : (
        <ul className="space-y-1">
          {relationships.map((rel) => (
            <li key={rel.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                <span className="text-gray-500 capitalize">{rel.relationship_type.replace(/_/g, " ")}</span>
                {" — "}
                <span className="font-mono text-xs text-gray-400">{rel.to_contact_id}</span>
              </span>
              <button
                onClick={() => removeRelationship(rel.id)}
                disabled={removing === rel.id}
                className="text-xs text-red-500 hover:underline disabled:opacity-50 shrink-0"
              >
                {removing === rel.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <div className="flex flex-col gap-2 mt-1 p-3 border border-gray-200 rounded-md bg-gray-50">
          <div className="flex flex-col gap-1">
            <Label htmlFor="rel-type" className="text-xs">Type</Label>
            <select
              id="rel-type"
              value={relType}
              onChange={(e) => setRelType(e.target.value)}
              className="text-sm border border-gray-200 rounded px-2 py-1 bg-white"
              disabled={submitting}
            >
              {RELATIONSHIP_TYPES.map((t) => (
                <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="rel-contact" className="text-xs">Contact ID</Label>
            <Input
              id="rel-contact"
              value={toContactId}
              onChange={(e) => setToContactId(e.target.value)}
              placeholder="UUID of the related contact"
              className="text-sm"
              disabled={submitting}
            />
          </div>
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex gap-2 mt-1">
            <Button
              onClick={addRelationship}
              disabled={submitting || !toContactId.trim()}
            >
              {submitting ? "Adding…" : "Add"}
            </Button>
            <Button
              variant="outline"
              onClick={() => { setAdding(false); setAddError(null); setToContactId(""); }}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="text-sm text-blue-600 hover:underline text-left w-fit"
        >
          + Add relationship
        </button>
      )}
    </div>
  );
}
