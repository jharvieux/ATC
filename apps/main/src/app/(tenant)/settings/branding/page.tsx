"use client";

// §16 — Tenant branding settings (visible to all tenants; some controls
// are forced-on for lower tiers per §16.7).
//
// Simple form per user preference: logo URL inputs, color hex pickers,
// font family, slogan / about text, email-sending pattern, and a custom-
// domain request field that emails support@.

import React, { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

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
        provider — the platform doesn't host images directly today.
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
              <p className="font-medium">Show "Powered by AI Travel Concierge"</p>
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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Custom domain</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 mb-3">
            Want your concierge at <code>concierge.yourdomain.com</code> instead of our subdomain?
            Email <a href="mailto:support@aitravelconcierge.com?subject=Custom%20domain%20request" className="text-blue-600 underline">support@aitravelconcierge.com</a> with
            the domain you want. Our team will issue DNS instructions and provision the certificate.
          </p>
        </CardContent>
      </Card>

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
  return (
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
  );
}
