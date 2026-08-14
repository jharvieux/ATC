"use client";

// §16 — Tenant branding settings (visible to all tenants; some controls
// are forced-on for lower tiers per §16.7).
//
// Simple form per user preference: logo URL inputs, color hex pickers,
// font family, slogan / about text, email-sending pattern, and a custom-
// domain request field that emails support@.

import React, { useEffect, useState } from "react";
import { formatDate } from "@/lib/format-date";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { contrastWarning } from "@/lib/branding/tenant-theme";

const TEXT_INPUT_CLS =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

type EmailPattern = "platform_resend" | "tenant_resend";

interface BrandingFields {
  logo_url: string;
  logo_dark_url: string;
  favicon_url: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  font_family: string;
  slogan: string;
  about_text: string;
  email_send_pattern: EmailPattern;
  email_from_domain: string;
  email_from_address: string;
  email_from_name: string;
  show_powered_by: boolean;
}

const EMPTY: BrandingFields = {
  logo_url: "",
  logo_dark_url: "",
  favicon_url: "",
  primary_color: "#1f2937",
  secondary_color: "#6b7280",
  accent_color: "#2563eb",
  font_family: "Inter, system-ui, sans-serif",
  slogan: "",
  about_text: "",
  email_send_pattern: "platform_resend",
  email_from_domain: "",
  email_from_address: "",
  email_from_name: "",
  show_powered_by: true,
};

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function isHex(s: string) {
  return HEX_RE.test(s);
}

export default function BrandingSettingsPage() {
  const [fields, setFields] = useState<BrandingFields>(EMPTY);
  const [forcePoweredBy, setForcePoweredBy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tenant/branding");
        if (!res.ok) throw new Error(`load_failed_${res.status}`);
        const data = (await res.json()) as { branding: Partial<BrandingFields> | null };
        if (cancelled) return;
        if (data.branding) {
          setFields((prev) => ({ ...prev, ...data.branding }));
          if (data.branding.show_powered_by === true) {
            // We can't know force-state from this endpoint; treat as forced
            // only if the value sticks after a save toggle attempt. Server
            // will coerce to true again if forced.
            setForcePoweredBy(false);
          }
        }
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "load_failed");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    setError(null);
    if (!isHex(fields.primary_color) || !isHex(fields.secondary_color) || !isHex(fields.accent_color)) {
      setError("Colors must be valid hex codes like #2563EB.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/branding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = (await res.json()) as { error?: string; show_powered_by?: boolean };
      if (!res.ok) {
        setError(data.error ?? "save_failed");
        return;
      }
      if (data.show_powered_by !== undefined && fields.show_powered_by === false && data.show_powered_by === true) {
        setForcePoweredBy(true);
        setFields((s) => ({ ...s, show_powered_by: true }));
      }
      setSavedAt(new Date().toLocaleTimeString());
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof BrandingFields>(k: K, v: BrandingFields[K]) {
    setFields((s) => ({ ...s, [k]: v }));
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-gray-500">Loading branding settings…</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">Branding</h1>
      <p className="text-gray-500 mb-8">
        Customize how your concierge appears to customers. Upload image URLs from your hosting
        provider — the platform doesn&apos;t host images directly today.
      </p>

      {error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}
      {savedAt && !error && (
        <div className="mb-6 p-3 bg-green-50 border border-green-200 rounded text-green-700 text-sm">
          Saved at {savedAt}.
        </div>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Logos and favicon</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <LabeledInput label="Light-mode logo URL" value={fields.logo_url} onChange={(v) => update("logo_url", v)} placeholder="https://example.com/logo.png" />
          <LabeledInput label="Dark-mode logo URL" value={fields.logo_dark_url} onChange={(v) => update("logo_dark_url", v)} placeholder="https://example.com/logo-dark.png" />
          <LabeledInput label="Favicon URL" value={fields.favicon_url} onChange={(v) => update("favicon_url", v)} placeholder="https://example.com/favicon.ico" />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Colors and typography</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ColorPicker label="Primary color" value={fields.primary_color} onChange={(v) => update("primary_color", v)} />
          <ColorPicker label="Secondary color" value={fields.secondary_color} onChange={(v) => update("secondary_color", v)} />
          <ColorPicker label="Accent color" value={fields.accent_color} onChange={(v) => update("accent_color", v)} />
          <LabeledInput label="Font family (CSS)" value={fields.font_family} onChange={(v) => update("font_family", v)} placeholder="Inter, system-ui, sans-serif" />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Copy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <LabeledInput label="Slogan (≤200 chars)" value={fields.slogan} onChange={(v) => update("slogan", v)} maxLength={200} placeholder="Your trusted cruise concierge" />
          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">About text (≤2000 chars)</span>
            <textarea
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm h-32"
              value={fields.about_text}
              maxLength={2000}
              onChange={(e) => update("about_text", e.target.value)}
              placeholder="Tell customers about your agency, who you serve, and what makes you different."
            />
          </label>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Outbound email</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Send pattern
            </label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="email_pattern"
                  checked={fields.email_send_pattern === "platform_resend"}
                  onChange={() => update("email_send_pattern", "platform_resend")}
                />
                Platform send (our Resend account)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="email_pattern"
                  checked={fields.email_send_pattern === "tenant_resend"}
                  onChange={() => update("email_send_pattern", "tenant_resend")}
                />
                Your own Resend account
              </label>
            </div>
          </div>
          <LabeledInput label="From domain (e.g. mail.yourdomain.com)" value={fields.email_from_domain} onChange={(v) => update("email_from_domain", v)} />
          <LabeledInput label="From address local part (before the @)" value={fields.email_from_address} onChange={(v) => update("email_from_address", v)} placeholder="hello" />
          <LabeledInput label="From display name" value={fields.email_from_name} onChange={(v) => update("email_from_name", v)} placeholder="Acme Travel" />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Powered-by attribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Show &ldquo;Powered by AI Travel Concierge&rdquo;</p>
              <p className="text-sm text-gray-500 mt-1">
                {forcePoweredBy
                  ? "Your subscription requires this attribution. Upgrade to remove it."
                  : "Subscription tiers with full white-label can hide this."}
              </p>
            </div>
            <Switch
              checked={fields.show_powered_by}
              onCheckedChange={(v) => update("show_powered_by", v)}
              disabled={forcePoweredBy || saving}
            />
          </div>
        </CardContent>
      </Card>

      <EmailDomainVerificationCard />

      <CustomDomainRequestCard />

      <SearchIndexingCard />

      <div className="flex justify-end gap-3">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function LabeledInput(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{props.label}</span>
      <input
        type="text"
        className={TEXT_INPUT_CLS}
        value={props.value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
      />
    </label>
  );
}

function ColorPicker(props: { label: string; value: string; onChange: (v: string) => void }) {
  // §16.2 — non-blocking WCAG AA contrast warning; the tenant can still save.
  const warning = isHex(props.value) ? contrastWarning(props.value) : null;
  return (
    <div>
      <label className="flex items-center gap-3">
        <span className="text-sm font-medium text-gray-700 w-32">{props.label}</span>
        <input
          type="color"
          value={isHex(props.value) ? props.value : "#000000"}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
          className="h-9 w-12 rounded border border-gray-300"
          aria-label={`${props.label} color picker`}
        />
        <input
          type="text"
          className={TEXT_INPUT_CLS + " w-32"}
          value={props.value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => props.onChange(e.target.value)}
        />
      </label>
      {warning && (
        <p className="mt-1 ml-[8.75rem] text-xs text-amber-700">{warning}</p>
      )}
    </div>
  );
}

interface DnsRecord {
  record?: string;
  name?: string;
  type?: string;
  value?: string;
  ttl?: number | string;
  priority?: number | string;
  status?: string;
}

interface VerifyStatusResponse {
  domain?: string | null;
  status: "verified" | "pending" | "not_configured";
  verified_at?: string | null;
  dns_records?: DnsRecord[];
}

function EmailDomainVerificationCard() {
  const [status, setStatus] = useState<VerifyStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/branding/email-domain/verify");
      if (!res.ok) throw new Error(`status_${res.status}`);
      const data = (await res.json()) as VerifyStatusResponse;
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function triggerVerify() {
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/branding/email-domain/verify", {
        method: "POST",
      });
      const data = (await res.json()) as VerifyStatusResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "verify_failed");
        return;
      }
      setStatus({
        domain: status?.domain ?? null,
        status: data.status,
        verified_at: data.verified_at ?? null,
        dns_records: data.dns_records ?? [],
      });
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Email-from domain verification</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-gray-600">
          Once you&apos;ve set your from domain above and saved, verify it here so outbound
          emails come from your domain instead of the platform default.
        </p>
        {loading ? (
          <p className="text-sm text-gray-500">Loading verification status…</p>
        ) : error ? (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        ) : status?.status === "not_configured" || !status?.domain ? (
          <p className="text-sm text-gray-500">
            No email-from domain set yet. Add one in the section above, click Save, then return here.
          </p>
        ) : (
          <>
            <div className="text-sm flex items-center gap-2">
              <span className="font-medium">{status.domain}</span>
              {status.status === "verified" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                  ✓ Verified
                  {status.verified_at && (
                    <span className="text-green-700">
                      &nbsp;{formatDate(status.verified_at)}
                    </span>
                  )}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  Pending DNS
                </span>
              )}
            </div>

            {status.status !== "verified" && status.dns_records && status.dns_records.length > 0 && (
              <div className="overflow-hidden rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Type</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Name</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">Value</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-600">TTL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.dns_records.map((r, i) => (
                      <tr key={i} className="border-t align-top">
                        <td className="px-3 py-2 text-gray-700">{r.type ?? r.record ?? "—"}</td>
                        <td className="px-3 py-2 text-gray-700 font-mono break-all">{r.name ?? "—"}</td>
                        <td className="px-3 py-2 text-gray-700 font-mono break-all">{r.value ?? "—"}</td>
                        <td className="px-3 py-2 text-gray-700">{r.ttl ?? "auto"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-gray-500 px-3 py-2 bg-gray-50 border-t">
                  Add these records at your DNS registrar, wait a few minutes for propagation, then click Verify.
                </p>
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={() => void triggerVerify()} disabled={verifying}>
                {verifying ? "Verifying…" : status.status === "verified" ? "Re-verify" : "Verify now"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CustomDomainRequestCard() {
  const [hostname, setHostname] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit() {
    setResult(null);
    if (!hostname.trim()) {
      setResult({ ok: false, message: "Enter the domain you&apos;d like to use." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/branding/custom-domain-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ desired_hostname: hostname.trim(), notes: notes.trim() }),
      });
      const data = (await res.json()) as { error?: string; note?: string };
      if (!res.ok) {
        setResult({ ok: false, message: data.error ?? "request_failed" });
        return;
      }
      setResult({
        ok: true,
        message: data.note ?? "Request received. Our team will be in touch.",
      });
      setHostname("");
      setNotes("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Custom domain</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-gray-600">
          By default your concierge lives at <code>&lt;your-slug&gt;.ai-travelconcierge.com</code>.
          To use your own subdomain (e.g. <code>concierge.yourdomain.com</code>), submit it here.
          Our team emails you DNS instructions and provisions the HTTPS certificate.
        </p>
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">
            Desired hostname
          </span>
          <input
            type="text"
            className={TEXT_INPUT_CLS}
            value={hostname}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHostname(e.target.value)}
            placeholder="concierge.yourdomain.com"
          />
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">
            Notes (optional)
          </span>
          <textarea
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm h-20"
            value={notes}
            maxLength={500}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="When you'd like this active, any DNS constraints we should know about, etc."
          />
        </label>
        {result && (
          <div
            className={
              "p-3 rounded text-sm " +
              (result.ok
                ? "bg-green-50 border border-green-200 text-green-700"
                : "bg-red-50 border border-red-200 text-red-700")
            }
          >
            {result.message}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={onSubmit} disabled={submitting || !hostname.trim()}>
            {submitting ? "Submitting…" : "Submit request"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface SearchIndexingStatus {
  agency_eligible: boolean;
  custom_domain: string | null;
  custom_domain_status: string;
  search_indexing_enabled: boolean;
}

export function SearchIndexingCard() {
  const [status, setStatus] = useState<SearchIndexingStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/tenant/search-indexing");
        if (!res.ok) throw new Error(`load_failed_${res.status}`);
        const data = (await res.json()) as SearchIndexingStatus;
        if (!cancelled) setStatus(data);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "load_failed",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function setEnabled(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/search-indexing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search_indexing_enabled: enabled }),
      });
      const data = (await res.json()) as {
        error?: string;
        search_indexing_enabled?: boolean;
      };
      if (!res.ok) {
        setError(data.error ?? "save_failed");
        return;
      }
      setStatus((current) =>
        current
          ? {
              ...current,
              search_indexing_enabled:
                data.search_indexing_enabled ?? enabled,
            }
          : current,
      );
    } finally {
      setSaving(false);
    }
  }

  if (!status && !error) return null;

  const verified =
    status?.custom_domain != null &&
    status.custom_domain_status === "verified";

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">Search indexing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
            {error}
          </div>
        )}
        {!status?.agency_eligible ? (
          <p className="text-sm text-gray-600">
            Search indexing for a custom domain is available on the Agency
            tier.
          </p>
        ) : !verified ? (
          <p className="text-sm text-gray-600">
            Verify your custom domain before enabling search indexing. Your
            platform subdomain always stays out of search results.
          </p>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">Allow search engines to index</p>
              <p className="text-sm text-gray-500 mt-1">
                {status.custom_domain} will publish its own robots policy and
                sitemap. Your platform subdomain remains private from search.
              </p>
            </div>
            <Switch
              aria-label="Allow search engines to index this custom domain"
              checked={status.search_indexing_enabled}
              onCheckedChange={(enabled) => void setEnabled(enabled)}
              disabled={saving}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
