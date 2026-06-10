"use client";

// §17.3 — Signup: provision workspace + collect full business profile in one step.
// After success the operator lands on /onboarding/legal — no separate profile step.

import { useState, useEffect, useRef } from "react";
import { TIMEZONES } from "@/lib/timezones";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function buildWorkspaceUrl(
  slug: string,
  location: { protocol: string; hostname: string },
): string {
  return `${location.protocol}//${slug}.${location.hostname}/onboarding/legal`;
}

type TenantType = "byo_host" | "sub_host";

// Mirrors the required-field checks in /api/auth/signup/complete (timezone and
// country always carry a value in the UI, so they're not checked here). Keys are
// inserted in on-page order — callers focus Object.keys(result)[0].
export function validateSignupForm(form: {
  display_name: string;
  legal_name: string;
  support_email: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.display_name.trim()) errors.display_name = "Agency display name is required.";
  if (!form.legal_name.trim()) errors.legal_name = "Legal business name is required.";
  if (!form.support_email.trim()) {
    errors.support_email = "Support email is required.";
  } else if (!/^\S+@\S+\.\S+$/.test(form.support_email.trim())) {
    errors.support_email = "Enter a valid email address.";
  }
  if (!form.line1.trim()) errors.line1 = "Street address is required.";
  if (!form.city.trim()) errors.city = "City is required.";
  if (!form.state.trim()) errors.state = "State is required.";
  if (!form.zip.trim()) errors.zip = "ZIP is required.";
  return errors;
}

export default function SignupCompletePage(): React.ReactElement {
  const [form, setForm] = useState({
    display_name: "",
    legal_name: "",
    tenant_type: "byo_host" as TenantType,
    support_email: "",
    support_phone: "",
    timezone: "America/New_York",
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
  });
  const [slug, setSlug] = useState("");
  const [slugChecking, setSlugChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [workspaceUrl, setWorkspaceUrl] = useState<string | null>(null);
  const suffixRef = useRef(0);

  // Auto-generate a unique slug whenever display_name changes.
  useEffect(() => {
    if (!form.display_name) { setSlug(""); return; }
    const base = form.display_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 55);
    if (!base) { setSlug(""); return; }

    setSlugChecking(true);
    suffixRef.current += 1;
    const myRound = suffixRef.current;

    const find = async () => {
      let candidate = base;
      let n = 2;
      while (n <= 99) {
        const res = await fetch(`/api/tenants/slug-check?candidate=${encodeURIComponent(candidate)}`);
        const data = await res.json() as { available?: boolean };
        if (myRound !== suffixRef.current) return; // stale — a newer name change fired
        if (data.available) { setSlug(candidate); setSlugChecking(false); return; }
        candidate = `${base}-${n}`;
        n++;
      }
      setSlug(base); // give up after 99 — let the server reject and user sees slug_taken
      setSlugChecking(false);
    };

    const t = setTimeout(find, 350);
    return () => clearTimeout(t);
  }, [form.display_name]);

  const set = (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [field]: e.target.value }));
      setFieldErrors((errs) => {
        if (!(field in errs)) return errs;
        const { [field]: _cleared, ...rest } = errs;
        return rest;
      });
    };

  // Red border + matching id so the first invalid field can be focused on submit.
  const errorProps = (field: keyof typeof form) => ({
    id: field,
    "aria-invalid": fieldErrors[field] ? true : undefined,
    className: fieldErrors[field] ? "border-red-600 dark:border-red-400" : undefined,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const errors = validateSignupForm(form);
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      setFieldErrors(errors);
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    setFieldErrors({});

    if (slugChecking || !slug) {
      setError(
        slugChecking
          ? "Still checking workspace URL availability — please try again in a moment."
          : "We couldn't generate a workspace URL from your agency name. Please adjust the display name and try again.",
      );
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name:  form.display_name,
          legal_name:    form.legal_name,
          slug,
          tenant_type:   form.tenant_type,
          support_email: form.support_email,
          support_phone: form.support_phone || undefined,
          timezone:      form.timezone,
          mailing_address: {
            line1:   form.line1,
            line2:   form.line2 || undefined,
            city:    form.city,
            state:   form.state,
            zip:     form.zip,
            country: form.country,
          },
        }),
      });

      const data = await res.json() as { slug?: string; error?: string };

      if (res.status === 201 && data.slug) {
        setWorkspaceUrl(buildWorkspaceUrl(data.slug, window.location));
        return;
      }
      if (res.status === 409 && data.error === "already_provisioned") {
        setError("Your workspace is already set up. Use the link on your workspace subdomain to continue.");
        return;
      }
      if (res.status === 409 && data.error === "slug_taken") {
        setError("That workspace name is already taken. Please change your agency display name and try again.");
        return;
      }
      if (res.status === 401) {
        window.location.href = "/signup";
        return;
      }
      setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (workspaceUrl) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen gap-6 p-4">
        <div className="text-5xl leading-none">✓</div>
        <h1 className="text-2xl font-bold">Your workspace is ready</h1>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          Click below to continue setup. You&apos;ll be asked to sign in once more to establish
          your session on your workspace subdomain.
        </p>
        <Button asChild className="px-7 h-auto py-3">
          <a href={workspaceUrl}>Continue to your workspace →</a>
        </Button>
        <p className="text-xs text-muted-foreground">{workspaceUrl}</p>
      </main>
    );
  }

  return (
    <main className="py-10 px-4">
      <div className="w-full max-w-lg mx-auto">
        <h1 className="text-2xl font-bold mb-2">Set up your agency</h1>
        <p className="text-muted-foreground text-sm mb-8">
          Fill this in once — your workspace will be ready to use immediately after.
        </p>

        {/* noValidate: required-field feedback is rendered inline (red border + message) instead of native bubbles. */}
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
          <Section title="Agency">
            <Field label="Agency display name *" error={fieldErrors.display_name}>
              <Input value={form.display_name} onChange={set("display_name")} required placeholder="Acme Travel" {...errorProps("display_name")} />
            </Field>
            <Field label="Legal business name *" error={fieldErrors.legal_name}>
              <Input value={form.legal_name} onChange={set("legal_name")} required placeholder="Acme Travel LLC" {...errorProps("legal_name")} />
            </Field>
            <Field
              label="Workspace URL"
              hint={
                slugChecking ? "Checking availability…" :
                slug ? `✓ ${slug}.${typeof window !== "undefined" ? window.location.hostname : "…"}` : ""
              }
              hintVariant={slug && !slugChecking ? "success" : "default"}
            >
              <Input
                value={slug}
                readOnly
                placeholder="generated from agency name"
                className="bg-muted text-muted-foreground cursor-default"
              />
            </Field>
            <Field label="Account type *">
              <div className="flex flex-col gap-2.5">
                {/* sub_host option hidden for now (#961) — type + server handling stay; default remains byo_host. */}
                <RadioOption value="byo_host" checked={form.tenant_type === "byo_host"}
                  onChange={() => setForm((f) => ({ ...f, tenant_type: "byo_host" }))}
                  label="Independent agency (BYO host)"
                  description="I work with my own host agency or am a direct seller." />
              </div>
            </Field>
          </Section>

          <Section title="Contact & Support">
            <Field label="Support email *" error={fieldErrors.support_email}>
              <Input type="email" value={form.support_email} onChange={set("support_email")} required placeholder="support@acmetravel.com" {...errorProps("support_email")} />
            </Field>
            <Field label="Support phone">
              <Input value={form.support_phone} onChange={set("support_phone")} placeholder="+1 555 000 0000" />
            </Field>
            <Field label="Time zone *">
              <Select value={form.timezone} onValueChange={(value) => setForm((f) => ({ ...f, timezone: value }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>{tz.label} ({tz.offset})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </Section>

          <Section title="Mailing Address">
            <Field label="Street address *" error={fieldErrors.line1}>
              <Input value={form.line1} onChange={set("line1")} required placeholder="123 Main St" {...errorProps("line1")} />
            </Field>
            <Field label="Apt, suite, etc.">
              <Input value={form.line2} onChange={set("line2")} placeholder="Suite 100" />
            </Field>
            <div className="grid gap-2.5 [grid-template-columns:1fr_80px_100px]">
              <Field label="City *" error={fieldErrors.city}>
                <Input value={form.city} onChange={set("city")} required {...errorProps("city")} />
              </Field>
              <Field label="State *" error={fieldErrors.state}>
                <Input value={form.state} onChange={set("state")} required maxLength={2} {...errorProps("state")} />
              </Field>
              <Field label="ZIP *" error={fieldErrors.zip}>
                <Input value={form.zip} onChange={set("zip")} required {...errorProps("zip")} />
              </Field>
            </div>
          </Section>

          {error && <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>}

          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating workspace…" : "Create workspace"}
          </Button>
        </form>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <fieldset className="border border-border rounded-lg p-4 pb-2 min-w-0">
      <legend className="text-xs font-semibold text-foreground px-1">{title}</legend>
      <div className="flex flex-col gap-3.5">{children}</div>
    </fieldset>
  );
}

function Field({ label, hint, hintVariant = "default", error, children }: {
  label: string; hint?: string; hintVariant?: "default" | "success"; error?: string | undefined; children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5">{label}</label>
      {children}
      {error && <p className="text-xs mt-1 text-red-600 dark:text-red-400">{error}</p>}
      {hint && (
        <p className={`text-xs mt-1 ${hintVariant === "success" ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function RadioOption({ value, checked, onChange, label, description }: {
  value: string; checked: boolean; onChange: () => void; label: string; description: string;
}): React.ReactElement {
  return (
    <label className={`flex gap-3 p-3 border rounded-lg cursor-pointer ${checked ? "border-primary bg-primary/5" : "border-border bg-background"}`}>
      <input type="radio" name="tenant_type" value={value} checked={checked} onChange={onChange} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </label>
  );
}
