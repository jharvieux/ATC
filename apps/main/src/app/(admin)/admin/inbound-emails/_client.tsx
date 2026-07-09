"use client";

// #1728 Phase 2 — inbound persona-email triage list. Renders the metadata-only
// rows from GET /api/admin/inbound-emails (no bodies). The "unresolved" filter
// surfaces mail the resolver couldn't tenant-attribute (tenant_id NULL) so an
// operator can chase it instead of it being silently dropped.

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

interface InboundEmail {
  id: string;
  provider_message_id: string;
  tenant_id: string | null;
  contact_id: string | null;
  from_email: string;
  to_email: string;
  subject: string | null;
  resolution: string;
  spf_result: string | null;
  dkim_result: string | null;
  forwarded_email_log_id: string | null;
  received_at: string;
}

export default function InboundEmailsClient(): React.JSX.Element {
  const [rows, setRows] = useState<InboundEmail[]>([]);
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch(
        `/api/admin/inbound-emails${unresolvedOnly ? "?unresolved=true" : ""}`,
      );
      if (!res.ok) {
        setError(res.status === 403 ? "Not authorized" : `Failed to load (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as { inbound_emails: InboundEmail[] };
      setRows(data.inbound_emails ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [unresolvedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="px-6 py-8 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-1">Inbound emails</h1>
      <p className="text-muted-foreground text-[14px] mb-5">
        Replies customers sent to persona addresses. Resolved replies are forwarded to
        the tenant and attached to the CRM timeline; unresolved ones land here for triage.
      </p>

      <label className="flex items-center gap-2 text-[13px] mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={unresolvedOnly}
          onChange={(e) => setUnresolvedOnly(e.target.checked)}
        />
        Unresolved only
      </label>

      {error && <p className="text-[13px] text-red-700 dark:text-red-400 mb-3">{error}</p>}
      {loading ? (
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No inbound emails.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-3 font-medium">Received</th>
                <th className="py-2 pr-3 font-medium">From</th>
                <th className="py-2 pr-3 font-medium">Subject</th>
                <th className="py-2 pr-3 font-medium">Resolution</th>
                <th className="py-2 pr-3 font-medium">SPF / DKIM</th>
                <th className="py-2 pr-3 font-medium">Forwarded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/50 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {new Date(r.received_at).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3">{r.from_email}</td>
                  <td className="py-2 pr-3">{r.subject ?? "(no subject)"}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        r.resolution === "unresolved"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-foreground"
                      }
                    >
                      {r.resolution}
                    </span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {(r.spf_result ?? "—")} / {(r.dkim_result ?? "—")}
                  </td>
                  <td className="py-2 pr-3">{r.forwarded_email_log_id ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
