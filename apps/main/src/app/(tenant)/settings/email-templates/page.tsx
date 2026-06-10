"use client";

// #963 — Tenant email template overrides.
//
// Lists every overridable outgoing email type, lets a tenant owner edit the
// subject and body (with {{variable}} placeholders documented per type),
// shows a live preview rendered with sample data, and resets to the
// platform default. Validation mirrors the server: unknown variables are
// flagged before save, and the server rejects them again on PUT.

import React, { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { validateTemplate, renderTemplate, bodyTextToHtml } from "@/lib/email/template-engine";

const TEXT_INPUT_CLS =
  "w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

interface TemplateVariable {
  name: string;
  description: string;
  sample: string;
}

interface TemplateEntry {
  type: string;
  label: string;
  description: string;
  default_subject_template: string;
  variables: TemplateVariable[];
  override: {
    subject_template: string | null;
    body_template: string | null;
    updated_at: string;
  } | null;
}

export default function EmailTemplatesSettingsPage() {
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/tenant/email-templates");
    if (!res.ok) throw new Error(`load_failed_${res.status}`);
    const data = (await res.json()) as { templates: TemplateEntry[] };
    setTemplates(data.templates);
    return data.templates;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await load();
        if (!cancelled && list.length > 0 && list[0]) setSelectedType(list[0].type);
      } catch {
        if (!cancelled) setError("Failed to load email templates.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = templates.find((t) => t.type === selectedType) ?? null;

  useEffect(() => {
    if (!selected) return;
    setSubject(selected.override?.subject_template ?? "");
    setBody(selected.override?.body_template ?? "");
    setError(null);
    setSavedAt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType, templates]);

  const allowedNames = useMemo(() => (selected ? selected.variables.map((v) => v.name) : []), [selected]);
  const sampleValues = useMemo(() => {
    const vals: Record<string, string> = {};
    for (const v of selected?.variables ?? []) vals[v.name] = v.sample;
    return vals;
  }, [selected]);

  const issues = useMemo(() => {
    if (!selected) return [];
    return [
      ...(subject.trim() ? validateTemplate(subject, allowedNames) : []),
      ...(body.trim() ? validateTemplate(body, allowedNames) : []),
    ];
  }, [selected, subject, body, allowedNames]);

  const preview = useMemo(() => {
    if (!selected || issues.length > 0) return null;
    try {
      return {
        subject: renderTemplate(subject.trim() || selected.default_subject_template, sampleValues),
        bodyHtml: body.trim() ? bodyTextToHtml(renderTemplate(body, sampleValues)) : null,
      };
    } catch {
      return null;
    }
  }, [selected, subject, body, sampleValues, issues]);

  async function save() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch(`/api/tenant/email-templates/${selected.type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_template: subject.trim() || null,
          body_template: body.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; issues?: { detail: string }[] }
          | null;
        if (data?.issues?.length) {
          setError(data.issues.map((i) => i.detail).join(" "));
        } else if (res.status === 403) {
          setError("Only the workspace owner can edit email templates.");
        } else {
          setError(`Save failed (${data?.error ?? res.status}).`);
        }
        return;
      }
      await load();
      setSavedAt(new Date().toLocaleTimeString());
    } catch {
      setError("Save failed — network error.");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!selected) return;
    if (!window.confirm(`Reset "${selected.label}" to the platform default?`)) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await fetch(`/api/tenant/email-templates/${selected.type}`, { method: "DELETE" });
      if (!res.ok) {
        setError(res.status === 403 ? "Only the workspace owner can edit email templates." : `Reset failed (${res.status}).`);
        return;
      }
      await load();
      setSubject("");
      setBody("");
      setSavedAt(new Date().toLocaleTimeString());
    } catch {
      setError("Reset failed — network error.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="px-6 py-10 max-w-[920px] mx-auto text-sm text-muted-foreground">Loading email templates…</main>;
  }

  return (
    <main className="px-6 py-10 max-w-[920px] mx-auto">
      <h1 className="text-2xl font-bold mb-1">Email Templates</h1>
      <p className="text-muted-foreground text-[14px] mb-6">
        Customize the subject and body of emails sent to your customers. Leave a field blank to keep the
        platform default for that part. Variables like {"{{customer_name}}"} are filled in at send time.
      </p>

      <div className="flex gap-6 flex-col md:flex-row">
        <nav className="md:w-[260px] shrink-0 flex flex-col gap-0.5">
          {templates.map((t) => (
            <button
              key={t.type}
              onClick={() => setSelectedType(t.type)}
              className={`text-left px-3 py-2 rounded text-[13px] border transition-colors ${
                t.type === selectedType ? "border-blue-500 bg-blue-50 font-semibold" : "border-transparent hover:bg-accent"
              }`}
            >
              {t.label}
              {t.override ? <span className="ml-2 text-[11px] text-blue-600">customized</span> : null}
            </button>
          ))}
        </nav>

        {selected ? (
          <div className="flex-1 flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{selected.label}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="text-[13px] text-muted-foreground">{selected.description}</p>

                <div>
                  <label className="block text-[13px] font-medium mb-1">Subject</label>
                  <input
                    className={TEXT_INPUT_CLS}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder={selected.default_subject_template}
                    maxLength={300}
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-medium mb-1">Body</label>
                  <textarea
                    className={`${TEXT_INPUT_CLS} min-h-[180px] font-mono`}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Leave blank to use the platform default body."
                    maxLength={10000}
                  />
                  <p className="text-[12px] text-muted-foreground mt-1">
                    Plain text. Blank lines start a new paragraph. Your branding header and the legally
                    required footer (business address, unsubscribe link) are always added automatically.
                  </p>
                </div>

                <div>
                  <p className="text-[13px] font-medium mb-1">Available variables</p>
                  <ul className="text-[12px] text-muted-foreground flex flex-col gap-0.5">
                    {selected.variables.map((v) => (
                      <li key={v.name}>
                        <code className="bg-accent px-1 rounded">{`{{${v.name}}}`}</code> — {v.description}
                      </li>
                    ))}
                  </ul>
                </div>

                {issues.length > 0 ? (
                  <div className="text-[13px] text-red-600">
                    {issues.map((i, idx) => (
                      <p key={idx}>{i.detail}</p>
                    ))}
                  </div>
                ) : null}
                {error ? <p className="text-[13px] text-red-600">{error}</p> : null}
                {savedAt ? <p className="text-[13px] text-green-700">Saved at {savedAt}.</p> : null}

                <div className="flex gap-2">
                  <Button onClick={save} disabled={saving || issues.length > 0 || (!subject.trim() && !body.trim())}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button variant="outline" onClick={resetToDefault} disabled={saving || !selected.override}>
                    Reset to default
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview (sample data)</CardTitle>
              </CardHeader>
              <CardContent>
                {preview ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[13px]">
                      <span className="font-medium">Subject:</span> {preview.subject}
                    </p>
                    {preview.bodyHtml ? (
                      <div
                        className="text-[13px] border border-border rounded p-3 [&_p]:mb-2"
                        // bodyTextToHtml HTML-escapes all content; only <p>/<br> structure is injected.
                        dangerouslySetInnerHTML={{ __html: preview.bodyHtml }}
                      />
                    ) : (
                      <p className="text-[13px] text-muted-foreground">
                        Body: platform default {selected.type.startsWith("pre_cruise") ? "(AI-generated content per cruise)" : ""}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">Fix the template errors above to see a preview.</p>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </main>
  );
}
