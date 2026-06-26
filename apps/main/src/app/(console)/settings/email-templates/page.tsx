"use client";

// #963 — Tenant email template overrides.
//
// Lists every overridable outgoing email type, lets a tenant owner edit the
// subject and body (with {{variable}} placeholders documented per type),
// shows a live preview rendered with sample data, and resets to the
// platform default. Validation mirrors the server: unknown variables are
// flagged before save, and the server rejects them again on PUT.
//
// Preview & Test additions: full HTML preview via the preview API (shown in a
// sandboxed iframe), sailing/booking data sources, and "Send to me" so owners
// can receive the email in their own inbox for review or manual forwarding.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ai_content: { description: string } | null;
  override: {
    subject_template: string | null;
    body_template: string | null;
    updated_at: string;
  } | null;
}

interface SailingResult {
  id: string;
  departure_date: string;
  departure_port: string;
  duration_nights: number;
  ship_name: string;
  cruise_line_name: string;
}

interface BookingResult {
  id: string;
  ship_name: string | null;
  cruise_line: string | null;
  sailing_date: string | null;
  primary_contact: { first_name: string | null; last_name: string | null } | null;
}

type PreviewSource = "sample" | "sailing" | "booking";

const AI_CONTENT_TOKEN_RE = /\{\{\s*ai_content\s*\}\}/;

function AiContentBlock(props: { description: string }) {
  return (
    <div className="border-2 border-dashed border-violet-400 bg-violet-50 rounded p-3 my-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700 mb-1">
        ✦ AI-generated content
      </p>
      <p className="text-[12px] text-violet-900 italic">{props.description}</p>
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function EmailTemplatesSettingsPage() {
  // ── Edit state ───────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<TemplateEntry[]>([]);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // ── Preview & Test state ─────────────────────────────────────────────────
  const [previewSource, setPreviewSource] = useState<PreviewSource>("sample");
  const [sailingQuery, setSailingQuery] = useState("");
  const [sailingResults, setSailingResults] = useState<SailingResult[]>([]);
  const [selectedSailing, setSelectedSailing] = useState<SailingResult | null>(null);
  const [sailingSearching, setSailingSearching] = useState(false);
  const [bookingQuery, setBookingQuery] = useState("");
  const [bookingResults, setBookingResults] = useState<BookingResult[]>([]);
  const [selectedBooking, setSelectedBooking] = useState<BookingResult | null>(null);
  const [bookingSearching, setBookingSearching] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewFetching, setPreviewFetching] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [sendToEmail, setSendToEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const sailingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load templates ───────────────────────────────────────────────────────
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
    // Reset preview when switching template types.
    setPreviewHtml(null);
    setSelectedSailing(null);
    setSelectedBooking(null);
    setSailingQuery("");
    setBookingQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType, templates]);

  // ── Template edit validation ─────────────────────────────────────────────
  const allowedNames = useMemo(() => (selected ? selected.variables.map((v) => v.name) : []), [selected]);
  const bodyAllowedNames = useMemo(
    () => (selected?.ai_content ? [...allowedNames, "ai_content"] : allowedNames),
    [selected, allowedNames],
  );
  const sampleValues = useMemo(() => {
    const vals: Record<string, string> = {};
    for (const v of selected?.variables ?? []) vals[v.name] = v.sample;
    return vals;
  }, [selected]);

  const issues = useMemo(() => {
    if (!selected) return [];
    return [
      ...(subject.trim() ? validateTemplate(subject, allowedNames) : []),
      ...(body.trim() ? validateTemplate(body, bodyAllowedNames) : []),
    ];
  }, [selected, subject, body, allowedNames, bodyAllowedNames]);

  const missingAiContent =
    !!selected?.ai_content && body.trim().length > 0 && !AI_CONTENT_TOKEN_RE.test(body);

  const textPreview = useMemo(() => {
    if (!selected || issues.length > 0) return null;
    try {
      return {
        subject: renderTemplate(subject.trim() || selected.default_subject_template, sampleValues),
        bodySegments: body.trim()
          ? body
              .split(new RegExp(AI_CONTENT_TOKEN_RE.source, "g"))
              .map((segment) => bodyTextToHtml(renderTemplate(segment, sampleValues)))
          : null,
      };
    } catch {
      return null;
    }
  }, [selected, subject, body, sampleValues, issues]);

  // ── Save / reset ─────────────────────────────────────────────────────────
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
        setError(
          res.status === 403
            ? "Only the workspace owner can edit email templates."
            : `Reset failed (${res.status}).`,
        );
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

  // ── Sailing search ───────────────────────────────────────────────────────
  const searchSailings = useCallback((q: string) => {
    if (sailingDebounceRef.current) clearTimeout(sailingDebounceRef.current);
    if (!q.trim()) {
      setSailingResults([]);
      return;
    }
    sailingDebounceRef.current = setTimeout(async () => {
      setSailingSearching(true);
      try {
        const res = await fetch(
          `/api/tenant/email-templates/sailings-search?q=${encodeURIComponent(q)}&limit=8`,
        );
        if (res.ok) {
          const data = (await res.json()) as { sailings: SailingResult[] };
          setSailingResults(data.sailings);
        }
      } finally {
        setSailingSearching(false);
      }
    }, 400);
  }, []);

  useEffect(() => {
    searchSailings(sailingQuery);
  }, [sailingQuery, searchSailings]);

  // ── Booking search ───────────────────────────────────────────────────────
  const searchBookings = useCallback((q: string) => {
    if (bookingDebounceRef.current) clearTimeout(bookingDebounceRef.current);
    if (!q.trim() || q.trim().length < 2) {
      setBookingResults([]);
      return;
    }
    bookingDebounceRef.current = setTimeout(async () => {
      setBookingSearching(true);
      try {
        const res = await fetch(
          `/api/bookings?contact_query=${encodeURIComponent(q)}&page_size=8`,
        );
        if (res.ok) {
          const data = (await res.json()) as { bookings: BookingResult[] };
          setBookingResults(data.bookings);
        }
      } finally {
        setBookingSearching(false);
      }
    }, 400);
  }, []);

  useEffect(() => {
    searchBookings(bookingQuery);
  }, [bookingQuery, searchBookings]);

  // ── Preview URL + load ───────────────────────────────────────────────────
  function previewUrl() {
    if (!selected) return null;
    const base = `/api/tenant/email-templates/${selected.type}/preview`;
    if (previewSource === "sailing" && selectedSailing) {
      return `${base}?sailing_id=${selectedSailing.id}`;
    }
    if (previewSource === "booking" && selectedBooking) {
      return `${base}?booking_id=${selectedBooking.id}`;
    }
    if (previewSource === "sample") return base;
    return null;
  }

  async function loadPreview() {
    const url = previewUrl();
    if (!url) return;
    setPreviewFetching(true);
    setPreviewHtml(null);
    try {
      const res = await fetch(url);
      if (res.ok) {
        setPreviewHtml(await res.text());
      } else {
        setPreviewHtml(
          `<p style="color:red;font-family:sans-serif;padding:16px">Preview failed (${res.status}).</p>`,
        );
      }
    } catch {
      setPreviewHtml(
        `<p style="color:red;font-family:sans-serif;padding:16px">Preview failed — network error.</p>`,
      );
    } finally {
      setPreviewFetching(false);
    }
  }

  // ── Send to me ───────────────────────────────────────────────────────────
  async function sendPreview() {
    if (!selected || !sendToEmail.trim()) return;
    setSending(true);
    setSendStatus(null);
    try {
      const body_payload: Record<string, string> = { to_email: sendToEmail.trim() };
      if (previewSource === "sailing" && selectedSailing) {
        body_payload.sailing_id = selectedSailing.id;
      } else if (previewSource === "booking" && selectedBooking) {
        body_payload.booking_id = selectedBooking.id;
      }
      const res = await fetch(`/api/tenant/email-templates/${selected.type}/send-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body_payload),
      });
      if (res.ok) {
        setSendStatus({ ok: true, message: `Preview sent to ${sendToEmail.trim()}.` });
      } else if (res.status === 429) {
        setSendStatus({ ok: false, message: "Daily limit reached (10 previews per day)." });
      } else if (res.status === 403) {
        setSendStatus({ ok: false, message: "Only the workspace owner can send preview emails." });
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setSendStatus({ ok: false, message: data?.error ?? `Send failed (${res.status}).` });
      }
    } catch {
      setSendStatus({ ok: false, message: "Send failed — network error." });
    } finally {
      setSending(false);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const canOpenPreview =
    previewSource === "sample" ||
    (previewSource === "sailing" && !!selectedSailing) ||
    (previewSource === "booking" && !!selectedBooking);

  if (loading) {
    return (
      <main className="px-6 py-10 max-w-[920px] mx-auto text-sm text-muted-foreground">
        Loading email templates…
      </main>
    );
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
                t.type === selectedType
                  ? "border-blue-500 bg-blue-50 font-semibold"
                  : "border-transparent hover:bg-accent"
              }`}
            >
              {t.label}
              {t.override ? (
                <span className="ml-2 text-[11px] text-blue-600">customized</span>
              ) : null}
            </button>
          ))}
        </nav>

        {selected ? (
          <div className="flex-1 flex flex-col gap-4">
            {/* ── Edit card ─────────────────────────────────────────────── */}
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
                    Plain text. Blank lines start a new paragraph. Your branding header and the
                    legally required footer (business address, unsubscribe link) are always added
                    automatically.
                  </p>
                </div>

                <div>
                  <p className="text-[13px] font-medium mb-1">Available variables</p>
                  <ul className="text-[12px] text-muted-foreground flex flex-col gap-0.5">
                    {selected.variables.map((v) => (
                      <li key={v.name}>
                        <code className="bg-accent px-1 rounded">{`{{${v.name}}}`}</code> —{" "}
                        {v.description}
                      </li>
                    ))}
                    {selected.ai_content ? (
                      <li>
                        <code className="bg-violet-100 text-violet-800 px-1 rounded">
                          {"{{ai_content}}"}
                        </code>{" "}
                        —{" "}
                        <span className="text-violet-800">{selected.ai_content.description}</span>{" "}
                        (body only)
                      </li>
                    ) : null}
                  </ul>
                </div>

                {missingAiContent ? (
                  <p className="text-[13px] text-amber-700 bg-amber-50 border border-amber-300 rounded px-3 py-2">
                    Your custom body doesn&apos;t include{" "}
                    <code className="bg-amber-100 px-1 rounded">{"{{ai_content}}"}</code>, so this
                    email will be sent without the AI-generated content. Add it where you want that
                    content to appear, or leave it out on purpose.
                  </p>
                ) : null}

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
                  <Button
                    onClick={save}
                    disabled={
                      saving || issues.length > 0 || (!subject.trim() && !body.trim())
                    }
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={resetToDefault}
                    disabled={saving || !selected.override}
                  >
                    Reset to default
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* ── Text preview (inline, updates as you type) ────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview (sample data)</CardTitle>
              </CardHeader>
              <CardContent>
                {textPreview ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[13px]">
                      <span className="font-medium">Subject:</span> {textPreview.subject}
                    </p>
                    {textPreview.bodySegments ? (
                      <div className="text-[13px] border border-border rounded p-3 [&_p]:mb-2">
                        {textPreview.bodySegments.map((segmentHtml, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && selected.ai_content ? (
                              <AiContentBlock description={selected.ai_content.description} />
                            ) : null}
                            {/* bodyTextToHtml HTML-escapes all content; only <p>/<br> structure is injected. */}
                            <div dangerouslySetInnerHTML={{ __html: segmentHtml }} />
                          </React.Fragment>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <p className="text-[13px] text-muted-foreground">
                          Body: platform default
                        </p>
                        {selected.ai_content ? (
                          <AiContentBlock description={selected.ai_content.description} />
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    Fix the template errors above to see a preview.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* ── Full preview & test ──────────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Full preview & test send</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="text-[13px] text-muted-foreground">
                  See the complete branded email (with your logo, colors, and footer). Optionally
                  populate template variables from a real sailing or booking.
                </p>

                {/* Data source picker */}
                <div>
                  <p className="text-[13px] font-medium mb-2">Data source</p>
                  <div className="flex flex-col gap-1.5">
                    {(
                      [
                        ["sample", "Sample data", "Uses placeholder values from the template registry."],
                        [
                          "sailing",
                          "Sailing from catalog",
                          "Populates ship name, cruise line, and departure date from a real sailing.",
                        ],
                        [
                          "booking",
                          "Customer booking",
                          "Populates customer name, ship name, and sailing date from a real booking.",
                        ],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <label
                        key={value}
                        className="flex items-start gap-2 cursor-pointer text-[13px]"
                      >
                        <input
                          type="radio"
                          name="preview-source"
                          value={value}
                          checked={previewSource === value}
                          onChange={() => {
                            setPreviewSource(value);
                            setPreviewHtml(null);
                          }}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">{label}</span>
                          <span className="text-muted-foreground ml-1">— {hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Sailing search */}
                {previewSource === "sailing" ? (
                  <div>
                    <label className="block text-[13px] font-medium mb-1">Search sailings</label>
                    <input
                      className={TEXT_INPUT_CLS}
                      value={selectedSailing ? `${selectedSailing.ship_name} — ${formatDate(selectedSailing.departure_date)} from ${selectedSailing.departure_port}` : sailingQuery}
                      onChange={(e) => {
                        setSelectedSailing(null);
                        setSailingQuery(e.target.value);
                        setPreviewHtml(null);
                      }}
                      placeholder="Type a ship name…"
                    />
                    {sailingSearching ? (
                      <p className="text-[12px] text-muted-foreground mt-1">Searching…</p>
                    ) : null}
                    {!selectedSailing && sailingResults.length > 0 ? (
                      <ul className="border border-border rounded mt-1 divide-y divide-border max-h-[200px] overflow-y-auto">
                        {sailingResults.map((s) => (
                          <li key={s.id}>
                            <button
                              onClick={() => {
                                setSelectedSailing(s);
                                setSailingResults([]);
                                setPreviewHtml(null);
                              }}
                              className="w-full text-left px-3 py-2 text-[13px] hover:bg-accent"
                            >
                              <span className="font-medium">{s.ship_name}</span>
                              <span className="text-muted-foreground ml-1">
                                — {s.cruise_line_name}
                              </span>
                              <br />
                              <span className="text-[12px] text-muted-foreground">
                                {formatDate(s.departure_date)} from {s.departure_port} ·{" "}
                                {s.duration_nights}n
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {selectedSailing ? (
                      <button
                        onClick={() => {
                          setSelectedSailing(null);
                          setSailingQuery("");
                          setPreviewHtml(null);
                        }}
                        className="text-[12px] text-blue-600 mt-1 hover:underline"
                      >
                        Clear selection
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {/* Booking search */}
                {previewSource === "booking" ? (
                  <div>
                    <label className="block text-[13px] font-medium mb-1">
                      Search bookings by customer name
                    </label>
                    <input
                      className={TEXT_INPUT_CLS}
                      value={
                        selectedBooking
                          ? [
                              selectedBooking.primary_contact?.first_name,
                              selectedBooking.primary_contact?.last_name,
                            ]
                              .filter(Boolean)
                              .join(" ") +
                            (selectedBooking.ship_name
                              ? ` — ${selectedBooking.ship_name}`
                              : "")
                          : bookingQuery
                      }
                      onChange={(e) => {
                        setSelectedBooking(null);
                        setBookingQuery(e.target.value);
                        setPreviewHtml(null);
                      }}
                      placeholder="Type a customer name…"
                    />
                    {bookingSearching ? (
                      <p className="text-[12px] text-muted-foreground mt-1">Searching…</p>
                    ) : null}
                    {!selectedBooking && bookingResults.length > 0 ? (
                      <ul className="border border-border rounded mt-1 divide-y divide-border max-h-[200px] overflow-y-auto">
                        {bookingResults.map((b) => {
                          const contactName = [
                            b.primary_contact?.first_name,
                            b.primary_contact?.last_name,
                          ]
                            .filter(Boolean)
                            .join(" ");
                          return (
                            <li key={b.id}>
                              <button
                                onClick={() => {
                                  setSelectedBooking(b);
                                  setBookingResults([]);
                                  setPreviewHtml(null);
                                }}
                                className="w-full text-left px-3 py-2 text-[13px] hover:bg-accent"
                              >
                                <span className="font-medium">{contactName || "Unknown"}</span>
                                {b.ship_name ? (
                                  <span className="text-muted-foreground ml-1">
                                    — {b.ship_name}
                                  </span>
                                ) : null}
                                {b.sailing_date ? (
                                  <span className="text-[12px] text-muted-foreground ml-1">
                                    ({formatDate(b.sailing_date)})
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    {selectedBooking ? (
                      <button
                        onClick={() => {
                          setSelectedBooking(null);
                          setBookingQuery("");
                          setPreviewHtml(null);
                        }}
                        className="text-[12px] text-blue-600 mt-1 hover:underline"
                      >
                        Clear selection
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {/* Actions */}
                <div className="flex gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    onClick={loadPreview}
                    disabled={!canOpenPreview || previewFetching}
                  >
                    {previewFetching ? "Loading…" : "Load preview"}
                  </Button>
                  {canOpenPreview ? (
                    <a
                      href={previewUrl() ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center px-4 py-2 text-sm rounded border border-border hover:bg-accent transition-colors"
                    >
                      Open in new tab ↗
                    </a>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSendDialogOpen(true);
                      setSendStatus(null);
                    }}
                    disabled={!canOpenPreview}
                  >
                    Send to my email
                  </Button>
                </div>

                {/* Inline HTML preview iframe */}
                {previewHtml ? (
                  <div className="border border-border rounded overflow-hidden">
                    <iframe
                      srcDoc={previewHtml}
                      sandbox="allow-same-origin"
                      className="w-full"
                      style={{ height: "600px", border: "none" }}
                      title="Email preview"
                    />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>

      {/* ── Send to me dialog ────────────────────────────────────────────── */}
      {sendDialogOpen ? (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSendDialogOpen(false);
          }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
            <h2 className="text-base font-semibold">Send preview to your inbox</h2>
            <p className="text-[13px] text-muted-foreground">
              This sends the email to your own inbox — not to any customer. Use it to review the
              full rendering or forward it to the customer manually.
            </p>
            <div>
              <label className="block text-[13px] font-medium mb-1">Your email address</label>
              <input
                className={TEXT_INPUT_CLS}
                type="email"
                value={sendToEmail}
                onChange={(e) => setSendToEmail(e.target.value)}
                placeholder="you@youragency.com"
                maxLength={254}
                autoFocus
              />
            </div>
            {sendStatus ? (
              <p
                className={`text-[13px] ${sendStatus.ok ? "text-green-700" : "text-red-600"}`}
              >
                {sendStatus.message}
              </p>
            ) : null}
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setSendDialogOpen(false)}
              >
                Close
              </Button>
              <Button
                onClick={sendPreview}
                disabled={sending || !sendToEmail.trim()}
              >
                {sending ? "Sending…" : "Send preview"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
