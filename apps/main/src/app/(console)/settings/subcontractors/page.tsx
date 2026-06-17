"use client";

// §14.3a — Sub-host subcontractor management page.
// Only visible/accessible to sub_host tenants.
// Allows CRUD of named subcontractors with share rates.
// Revenue dashboards subtract the subcontractor's share to show net retained.
//
// The platform does NOT pay subcontractors — this is bookkeeping only.

import React, { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Subcontractor = {
  id: string;
  name: string;
  share_rate: number;
  created_at: string;
};

type FormState = {
  name: string;
  share_rate_pct: string; // entered as percent (e.g. "50" for 50%)
  saving: boolean;
  error: string | null;
};

const EMPTY_FORM: FormState = { name: "", share_rate_pct: "", saving: false, error: null };

export default function SubcontractorsPage() {
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => {
    fetchSubcontractors();
  }, []);

  async function fetchSubcontractors() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/subcontractors");
      if (res.status === 403) {
        setError("Subcontractor tracking is only available for sub-host accounts.");
        return;
      }
      const data = await res.json();
      setSubcontractors(data.subcontractors ?? []);
    } catch {
      setError("Failed to load subcontractors.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    const pct = parseFloat(form.share_rate_pct);
    if (!form.name.trim()) {
      setForm((f) => ({ ...f, error: "Name is required." }));
      return;
    }
    if (isNaN(pct) || pct < 0 || pct > 100) {
      setForm((f) => ({ ...f, error: "Share rate must be 0–100%." }));
      return;
    }

    setForm((f) => ({ ...f, saving: true, error: null }));
    const share_rate = pct / 100;

    try {
      let res: Response;
      if (editId) {
        res = await fetch(`/api/subcontractors/${editId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: form.name.trim(), share_rate }),
        });
      } else {
        res = await fetch("/api/subcontractors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: form.name.trim(), share_rate }),
        });
      }

      if (!res.ok) {
        const body = await res.json();
        setForm((f) => ({ ...f, saving: false, error: body.error ?? "Save failed." }));
        return;
      }
    } catch {
      setForm((f) => ({ ...f, saving: false, error: "Network error." }));
      return;
    }

    setForm(EMPTY_FORM);
    setEditId(null);
    fetchSubcontractors();
  }

  async function handleArchive(id: string) {
    try {
      await fetch(`/api/subcontractors/${id}`, { method: "DELETE" });
      fetchSubcontractors();
    } catch {
      setError("Failed to archive subcontractor.");
    }
  }

  function startEdit(sub: Subcontractor) {
    setEditId(sub.id);
    setForm({
      name: sub.name,
      share_rate_pct: (sub.share_rate * 100).toFixed(2).replace(/\.?0+$/, ""),
      saving: false,
      error: null,
    });
  }

  function cancelEdit() {
    setEditId(null);
    setForm(EMPTY_FORM);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Subcontractor Tracking</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Add subcontractors to forecast your net retained revenue. The platform does not pay
          subcontractors — this is for your bookkeeping only.
        </p>
      </div>

      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle>{editId ? "Edit Subcontractor" : "Add Subcontractor"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              className="border rounded px-3 py-2 w-full text-sm"
              placeholder="e.g. Sarah Martin"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              disabled={form.saving}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Share Rate (%)</label>
            <input
              className="border rounded px-3 py-2 w-32 text-sm"
              placeholder="e.g. 50"
              value={form.share_rate_pct}
              onChange={(e) => setForm((f) => ({ ...f, share_rate_pct: e.target.value }))}
              disabled={form.saving}
            />
            <p className="text-xs text-muted-foreground mt-1">
              This percentage of your sub-host payout will be shown as owed to this subcontractor.
            </p>
          </div>

          {form.error && <p className="text-sm text-red-600">{form.error}</p>}

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={form.saving}>
              {form.saving ? "Saving…" : editId ? "Save Changes" : "Add Subcontractor"}
            </Button>
            {editId && (
              <Button variant="outline" onClick={cancelEdit} disabled={form.saving}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active Subcontractors</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : subcontractors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subcontractors yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Share</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {subcontractors.map((sub) => (
                  <tr key={sub.id} className="border-b last:border-0">
                    <td className="py-2">{sub.name}</td>
                    <td className="py-2">{(sub.share_rate * 100).toFixed(0)}%</td>
                    <td className="py-2 text-right space-x-2">
                      <Button variant="outline" onClick={() => startEdit(sub)}>
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => handleArchive(sub.id)}
                      >
                        Archive
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
