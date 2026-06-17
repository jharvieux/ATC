"use client";

// §13.4 / §13.7 — Tenant host integration settings page.
// Lists available host adapters with their current config state.
// Allows connecting or re-entering credentials for each adapter.
// Credentials are posted to POST /api/tenant/host-config which encrypts before DB write.

import React, { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type AdapterStatus = "verified" | "pending" | "rejected" | "expired" | "revoked" | "not_configured";

type AdapterRecord = {
  adapter_id: string;
  display_name: string;
  capabilities: Record<string, unknown>;
  current_status: AdapterStatus;
};

type FormState = {
  adapter_id: string | null;
  credentials_json: string;
  saving: boolean;
  error: string | null;
};

const STATUS_LABELS: Record<AdapterStatus, { label: string; color: string }> = {
  verified: { label: "Verified", color: "text-green-600" },
  pending: { label: "Pending verification", color: "text-yellow-600" },
  rejected: { label: "Rejected — credentials invalid", color: "text-red-600" },
  expired: { label: "Expired", color: "text-orange-600" },
  revoked: { label: "Revoked", color: "text-red-700" },
  not_configured: { label: "Not configured", color: "text-gray-500" },
};

export default function HostIntegrationPage() {
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>({
    adapter_id: null,
    credentials_json: "",
    saving: false,
    error: null,
  });

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/tenant/host-config");
        if (res.ok) {
          const data = await res.json() as { adapters: AdapterRecord[] };
          setAdapters(data.adapters ?? []);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function openForm(adapter_id: string) {
    setForm({ adapter_id, credentials_json: "{}", saving: false, error: null });
  }

  function closeForm() {
    setForm({ adapter_id: null, credentials_json: "", saving: false, error: null });
  }

  async function submitCredentials(adapter_id: string) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(form.credentials_json) as Record<string, unknown>;
    } catch {
      setForm((f) => ({ ...f, error: "Credentials must be valid JSON." }));
      return;
    }

    setForm((f) => ({ ...f, saving: true, error: null }));
    try {
      const res = await fetch("/api/tenant/host-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter_id, credentials_json: parsed }),
      });
      const data = await res.json() as { ok?: boolean; credential_status?: AdapterStatus; error?: string };
      if (!res.ok) {
        setForm((f) => ({ ...f, saving: false, error: data.error ?? "Save failed." }));
        return;
      }
      const newStatus = data.credential_status ?? "pending";
      setAdapters((prev) =>
        prev.map((a) =>
          a.adapter_id === adapter_id ? { ...a, current_status: newStatus } : a,
        ),
      );
      closeForm();
    } catch {
      setForm((f) => ({ ...f, saving: false, error: "Network error." }));
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 text-gray-500">Loading host integrations...</div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">Host Integration</h1>
      <p className="text-gray-500 mb-8">
        Connect your travel host agency to enable real-time booking submission. Credentials are
        encrypted at rest.
      </p>

      {adapters.length === 0 && (
        <div className="text-gray-400 text-sm">No host adapters are currently available.</div>
      )}

      <div className="grid gap-4">
        {adapters.map((adapter) => {
          const statusInfo = STATUS_LABELS[adapter.current_status];
          const isFormOpen = form.adapter_id === adapter.adapter_id;

          return (
            <Card key={adapter.adapter_id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{adapter.display_name}</CardTitle>
                  <span className={`text-sm font-medium ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  {adapter.current_status === "not_configured" ? (
                    <Button onClick={() => openForm(adapter.adapter_id)}>
                      Connect
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => openForm(adapter.adapter_id)}
                    >
                      Re-enter credentials
                    </Button>
                  )}
                </div>

                {isFormOpen && (
                  <div className="mt-4 border rounded p-4 bg-gray-50">
                    <p className="text-sm font-medium mb-2">
                      Enter credentials for {adapter.display_name}
                    </p>
                    <p className="text-xs text-gray-500 mb-3">
                      Paste your adapter credentials as JSON. These are encrypted before storage and
                      never stored in plaintext.
                    </p>
                    <textarea
                      className="w-full font-mono text-sm border rounded p-2 h-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      value={form.credentials_json}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, credentials_json: e.target.value }))
                      }
                      disabled={form.saving}
                      aria-label="Credentials JSON"
                    />
                    {form.error && (
                      <p className="text-red-600 text-sm mt-2">{form.error}</p>
                    )}
                    {adapter.current_status === "rejected" && (
                      <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                        Your credentials were rejected. Please re-enter valid credentials.
                      </div>
                    )}
                    <div className="flex gap-2 mt-3">
                      <Button
                        onClick={() => void submitCredentials(adapter.adapter_id)}
                        disabled={form.saving}
                      >
                        {form.saving ? "Saving..." : "Save & Verify"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={closeForm}
                        disabled={form.saving}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
