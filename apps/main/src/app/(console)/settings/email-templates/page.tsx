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
//
// #1812 — the 28 useState hooks are grouped into 4 state objects by concern
// (same pattern as #1791 / integrations/page.tsx), one useState each. The
// template-switch cascading-reset effect and the sailing/booking cascades are
// pinned by test/unit/settings/email-templates-cascading-state.test.tsx —
// this grouping preserves exactly which fields each cascade touches.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { validateTemplate, renderTemplate, bodyTextToHtml } from "@/lib/email/template-engine";
import { formatDate } from "@/lib/format-date";

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

interface CruiseLine {
  id: string;
  display_name: string;
}

interface CruiseShip {
  id: string;
  canonical_name: string;
  ship_class: string | null;
}

interface CruiseSailingOption {
  id: string;
  departure_date: string;
  departure_port: string;
  duration_nights: number;
}

interface BookingResult {
  id: string;
  ship_name: string | null;
  cruise_line: string | null;
  sailing_date: string | null;
  primary_contact: { first_name: string | null; last_name: string | null } | null;
}

type PreviewSource = "sample" | "sailing" | "booking";

interface EditState {
  templates: TemplateEntry[];
  selectedType: string | null;
  subject: string;
  body: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  savedAt: string | null;
}

interface SailingCascadeState {
  previewSource: PreviewSource;
  sailingLines: CruiseLine[];
  sailingShips: CruiseShip[];
  sailingOptions: CruiseSailingOption[];
  selectedLineId: string;
  selectedShipId: string;
  selectedSailingId: string;
  loadingSailingShips: boolean;
  loadingSailingOptions: boolean;
  selectedSailing: SailingResult | null;
}

interface BookingSearchState {
  bookingQuery: string;
  bookingResults: BookingResult[];
  selectedBooking: BookingResult | null;
  bookingSearching: boolean;
}

interface PreviewSendState {
  previewHtml: string | null;
  previewFetching: boolean;
  sendDialogOpen: boolean;
  sendToEmail: string;
  sending: boolean;
  sendStatus: { ok: boolean; message: string } | null;
}

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

export default function EmailTemplatesSettingsPage() {
  // ── Edit state ───────────────────────────────────────────────────────────
  const [editState, setEditState] = useState<EditState>({
    templates: [],
    selectedType: null,
    subject: "",
    body: "",
    loading: true,
    saving: false,
    error: null,
    savedAt: null,
  });

  // ── Sailing cascade: line → ship → sailing date ─────────────────────────
  const [sailingCascadeState, setSailingCascadeState] = useState<SailingCascadeState>({
    previewSource: "sample",
    sailingLines: [],
    sailingShips: [],
    sailingOptions: [],
    selectedLineId: "",
    selectedShipId: "",
    selectedSailingId: "",
    loadingSailingShips: false,
    loadingSailingOptions: false,
    selectedSailing: null,
  });

  // ── Booking search (debounced) ───────────────────────────────────────────
  const [bookingSearchState, setBookingSearchState] = useState<BookingSearchState>({
    bookingQuery: "",
    bookingResults: [],
    selectedBooking: null,
    bookingSearching: false,
  });

  // ── Full preview + "send to me" ──────────────────────────────────────────
  const [previewSendState, setPreviewSendState] = useState<PreviewSendState>({
    previewHtml: null,
    previewFetching: false,
    sendDialogOpen: false,
    sendToEmail: "",
    sending: false,
    sendStatus: null,
  });

  const bookingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load templates ───────────────────────────────────────────────────────
  async function load() {
    const res = await fetch("/api/tenant/email-templates");
    if (!res.ok) throw new Error(`load_failed_${res.status}`);
    const data = (await res.json()) as { templates: TemplateEntry[] };
    setEditState((s) => ({ ...s, templates: data.templates }));
    return data.templates;
  }

  // ── Load cruise lines (once on mount for the sailing cascade) ────────────
  const loadSailingLines = useCallback(async () => {
    try {
      const res = await fetch("/api/cruise-lines");
      if (res.ok) {
        const json = (await res.json()) as { lines: CruiseLine[] };
        setSailingCascadeState((s) => ({ ...s, sailingLines: json.lines ?? [] }));
      }
    } catch {
      // Silently leave the dropdown empty; user can switch template type to retry.
    }
  }, []);

  const loadSailingShips = useCallback(async (lineId: string) => {
    if (!lineId) {
      setSailingCascadeState((s) => ({ ...s, sailingShips: [] }));
      return;
    }
    setSailingCascadeState((s) => ({ ...s, loadingSailingShips: true }));
    try {
      const res = await fetch(`/api/cruise-ships?cruise_line_id=${encodeURIComponent(lineId)}`);
      if (res.ok) {
        const json = (await res.json()) as { ships: CruiseShip[] };
        setSailingCascadeState((s) => ({ ...s, sailingShips: json.ships ?? [] }));
      }
    } catch {
      // Silently leave ships empty; spinner already cleared by finally.
    } finally {
      setSailingCascadeState((s) => ({ ...s, loadingSailingShips: false }));
    }
  }, []);

  const loadSailingOptions = useCallback(async (shipId: string) => {
    if (!shipId) {
      setSailingCascadeState((s) => ({ ...s, sailingOptions: [] }));
      return;
    }
    setSailingCascadeState((s) => ({ ...s, loadingSailingOptions: true }));
    try {
      const res = await fetch(`/api/cruise-sailings?cruise_ship_id=${encodeURIComponent(shipId)}`);
      if (res.ok) {
        const json = (await res.json()) as { sailings: CruiseSailingOption[] };
        setSailingCascadeState((s) => ({ ...s, sailingOptions: json.sailings ?? [] }));
      }
    } catch {
      // Silently leave sailings empty; spinner already cleared by finally.
    } finally {
      setSailingCascadeState((s) => ({ ...s, loadingSailingOptions: false }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await load();
        if (!cancelled && list.length > 0 && list[0]) {
          setEditState((s) => ({ ...s, selectedType: list[0]!.type }));
        }
      } catch {
        if (!cancelled) setEditState((s) => ({ ...s, error: "Failed to load email templates." }));
      } finally {
        if (!cancelled) setEditState((s) => ({ ...s, loading: false }));
      }
    })();
    void loadSailingLines();
    return () => {
      cancelled = true;
    };
  }, [loadSailingLines]);

  const selected = editState.templates.find((t) => t.type === editState.selectedType) ?? null;

  useEffect(() => {
    if (!selected) return;
    setEditState((s) => ({
      ...s,
      subject: selected.override?.subject_template ?? "",
      body: selected.override?.body_template ?? "",
      error: null,
      savedAt: null,
    }));
    // Reset preview when switching template types.
    setPreviewSendState((s) => ({ ...s, previewHtml: null }));
    setSailingCascadeState((s) => ({
      ...s,
      selectedSailing: null,
      selectedLineId: "",
      selectedShipId: "",
      selectedSailingId: "",
      sailingShips: [],
      sailingOptions: [],
    }));
    setBookingSearchState((s) => ({ ...s, selectedBooking: null, bookingQuery: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editState.selectedType, editState.templates]);

  // ── Template edit validation ─────────────────────────────────────────────
  const allowedNames = useMemo(() => (selected ? selected.variables.map((v) => v.name) : []), [selected]);
  // {{ai_content}} is body-only: its value is multi-paragraph text that can't
  // fit in a subject line, so it's excluded from allowedNames for subject validation.
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
      ...(editState.subject.trim() ? validateTemplate(editState.subject, allowedNames) : []),
      ...(editState.body.trim() ? validateTemplate(editState.body, bodyAllowedNames) : []),
    ];
  }, [selected, editState.subject, editState.body, allowedNames, bodyAllowedNames]);

  const missingAiContent =
    !!selected?.ai_content && editState.body.trim().length > 0 && !AI_CONTENT_TOKEN_RE.test(editState.body);

  // Body preview as segments: text between {{ai_content}} tokens renders as
  // escaped HTML; each token position renders as a labeled AI placeholder
  // block so tenants see exactly where the AI content lands.
  const textPreview = useMemo(() => {
    if (!selected || issues.length > 0) return null;
    try {
      return {
        subject: renderTemplate(editState.subject.trim() || selected.default_subject_template, sampleValues),
        bodySegments: editState.body.trim()
          ? editState.body
              .split(new RegExp(AI_CONTENT_TOKEN_RE.source, "g"))
              .map((segment) => bodyTextToHtml(renderTemplate(segment, sampleValues)))
          : null,
      };
    } catch {
      return null;
    }
  }, [selected, editState.subject, editState.body, sampleValues, issues]);

  // ── Save / reset ─────────────────────────────────────────────────────────
  async function save() {
    if (!selected) return;
    setEditState((s) => ({ ...s, saving: true, error: null, savedAt: null }));
    try {
      const res = await fetch(`/api/tenant/email-templates/${selected.type}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_template: editState.subject.trim() || null,
          body_template: editState.body.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; issues?: { detail: string }[] }
          | null;
        if (data?.issues?.length) {
          setEditState((s) => ({ ...s, error: data.issues!.map((i) => i.detail).join(" ") }));
        } else if (res.status === 403) {
          setEditState((s) => ({ ...s, error: "Only the workspace owner can edit email templates." }));
        } else {
          setEditState((s) => ({ ...s, error: `Save failed (${data?.error ?? res.status}).` }));
        }
        return;
      }
      await load();
      setEditState((s) => ({ ...s, savedAt: new Date().toLocaleTimeString() }));
    } catch {
      setEditState((s) => ({ ...s, error: "Save failed — network error." }));
    } finally {
      setEditState((s) => ({ ...s, saving: false }));
    }
  }

  async function resetToDefault() {
    if (!selected) return;
    if (!window.confirm(`Reset "${selected.label}" to the platform default?`)) return;
    setEditState((s) => ({ ...s, saving: true, error: null, savedAt: null }));
    try {
      const res = await fetch(`/api/tenant/email-templates/${selected.type}`, { method: "DELETE" });
      if (!res.ok) {
        setEditState((s) => ({
          ...s,
          error:
            res.status === 403
              ? "Only the workspace owner can edit email templates."
              : `Reset failed (${res.status}).`,
        }));
        return;
      }
      await load();
      setEditState((s) => ({ ...s, subject: "", body: "", savedAt: new Date().toLocaleTimeString() }));
    } catch {
      setEditState((s) => ({ ...s, error: "Reset failed — network error." }));
    } finally {
      setEditState((s) => ({ ...s, saving: false }));
    }
  }

  // ── Sailing cascade handlers ─────────────────────────────────────────────
  function handleSailingLineChange(lineId: string): void {
    setSailingCascadeState((s) => ({
      ...s,
      selectedLineId: lineId,
      selectedShipId: "",
      selectedSailingId: "",
      selectedSailing: null,
      sailingShips: [],
      sailingOptions: [],
    }));
    setPreviewSendState((s) => ({ ...s, previewHtml: null }));
    void loadSailingShips(lineId);
  }

  function handleSailingShipChange(shipId: string): void {
    setSailingCascadeState((s) => ({
      ...s,
      selectedShipId: shipId,
      selectedSailingId: "",
      selectedSailing: null,
      sailingOptions: [],
    }));
    setPreviewSendState((s) => ({ ...s, previewHtml: null }));
    void loadSailingOptions(shipId);
  }

  function handleSailingDateChange(sailingId: string): void {
    const s = sailingCascadeState.sailingOptions.find((x) => x.id === sailingId) ?? null;
    const line = sailingCascadeState.sailingLines.find((x) => x.id === sailingCascadeState.selectedLineId);
    const ship = sailingCascadeState.sailingShips.find((x) => x.id === sailingCascadeState.selectedShipId);
    setSailingCascadeState((cur) => ({
      ...cur,
      selectedSailingId: sailingId,
      selectedSailing:
        s && line && ship
          ? {
              id: s.id,
              departure_date: s.departure_date,
              departure_port: s.departure_port,
              duration_nights: s.duration_nights,
              ship_name: ship.canonical_name,
              cruise_line_name: line.display_name,
            }
          : null,
    }));
    setPreviewSendState((cur) => ({ ...cur, previewHtml: null }));
  }

  // ── Booking search ───────────────────────────────────────────────────────
  const searchBookings = useCallback((q: string) => {
    if (bookingDebounceRef.current) clearTimeout(bookingDebounceRef.current);
    if (!q.trim() || q.trim().length < 2) {
      setBookingSearchState((s) => ({ ...s, bookingResults: [] }));
      return;
    }
    bookingDebounceRef.current = setTimeout(async () => {
      setBookingSearchState((s) => ({ ...s, bookingSearching: true }));
      try {
        const res = await fetch(
          `/api/bookings?contact_query=${encodeURIComponent(q)}&page_size=8`,
        );
        if (res.ok) {
          const data = (await res.json()) as { bookings: BookingResult[] };
          setBookingSearchState((s) => ({ ...s, bookingResults: data.bookings }));
        }
      } finally {
        setBookingSearchState((s) => ({ ...s, bookingSearching: false }));
      }
    }, 400);
  }, []);

  useEffect(() => {
    searchBookings(bookingSearchState.bookingQuery);
  }, [bookingSearchState.bookingQuery, searchBookings]);

  // ── Preview URL + load ───────────────────────────────────────────────────
  function previewUrl() {
    if (!selected) return null;
    const base = `/api/tenant/email-templates/${selected.type}/preview`;
    if (sailingCascadeState.previewSource === "sailing" && sailingCascadeState.selectedSailing) {
      return `${base}?sailing_id=${sailingCascadeState.selectedSailing.id}`;
    }
    if (sailingCascadeState.previewSource === "booking" && bookingSearchState.selectedBooking) {
      return `${base}?booking_id=${bookingSearchState.selectedBooking.id}`;
    }
    if (sailingCascadeState.previewSource === "sample") return base;
    return null;
  }

  async function loadPreview() {
    const url = previewUrl();
    if (!url) return;
    setPreviewSendState((s) => ({ ...s, previewFetching: true, previewHtml: null }));
    try {
      const res = await fetch(url);
      if (res.ok) {
        const html = await res.text();
        setPreviewSendState((s) => ({ ...s, previewHtml: html }));
      } else {
        setPreviewSendState((s) => ({
          ...s,
          previewHtml: `<p style="color:red;font-family:sans-serif;padding:16px">Preview failed (${res.status}).</p>`,
        }));
      }
    } catch {
      setPreviewSendState((s) => ({
        ...s,
        previewHtml: `<p style="color:red;font-family:sans-serif;padding:16px">Preview failed — network error.</p>`,
      }));
    } finally {
      setPreviewSendState((s) => ({ ...s, previewFetching: false }));
    }
  }

  // ── Send to me ───────────────────────────────────────────────────────────
  async function sendPreview() {
    if (!selected || !previewSendState.sendToEmail.trim()) return;
    setPreviewSendState((s) => ({ ...s, sending: true, sendStatus: null }));
    try {
      const body_payload: Record<string, string> = { to_email: previewSendState.sendToEmail.trim() };
      if (sailingCascadeState.previewSource === "sailing" && sailingCascadeState.selectedSailing) {
        body_payload.sailing_id = sailingCascadeState.selectedSailing.id;
      } else if (sailingCascadeState.previewSource === "booking" && bookingSearchState.selectedBooking) {
        body_payload.booking_id = bookingSearchState.selectedBooking.id;
      }
      const res = await fetch(`/api/tenant/email-templates/${selected.type}/send-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body_payload),
      });
      if (res.ok) {
        setPreviewSendState((s) => ({
          ...s,
          sendStatus: { ok: true, message: `Preview sent to ${previewSendState.sendToEmail.trim()}.` },
        }));
      } else if (res.status === 429) {
        setPreviewSendState((s) => ({
          ...s,
          sendStatus: { ok: false, message: "Daily limit reached (10 previews per day)." },
        }));
      } else if (res.status === 403) {
        setPreviewSendState((s) => ({
          ...s,
          sendStatus: { ok: false, message: "Only the workspace owner can send preview emails." },
        }));
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setPreviewSendState((s) => ({
          ...s,
          sendStatus: { ok: false, message: data?.error ?? `Send failed (${res.status}).` },
        }));
      }
    } catch {
      setPreviewSendState((s) => ({ ...s, sendStatus: { ok: false, message: "Send failed — network error." } }));
    } finally {
      setPreviewSendState((s) => ({ ...s, sending: false }));
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const canOpenPreview =
    sailingCascadeState.previewSource === "sample" ||
    (sailingCascadeState.previewSource === "sailing" && !!sailingCascadeState.selectedSailing) ||
    (sailingCascadeState.previewSource === "booking" && !!bookingSearchState.selectedBooking);

  if (editState.loading) {
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
          {editState.templates.map((t) => (
            <button
              key={t.type}
              onClick={() => setEditState((s) => ({ ...s, selectedType: t.type }))}
              className={`text-left px-3 py-2 rounded text-[13px] border transition-colors ${
                t.type === editState.selectedType
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
                    value={editState.subject}
                    onChange={(e) => setEditState((s) => ({ ...s, subject: e.target.value }))}
                    placeholder={selected.default_subject_template}
                    maxLength={300}
                  />
                </div>

                <div>
                  <label className="block text-[13px] font-medium mb-1">Body</label>
                  <textarea
                    className={`${TEXT_INPUT_CLS} min-h-[180px] font-mono`}
                    value={editState.body}
                    onChange={(e) => setEditState((s) => ({ ...s, body: e.target.value }))}
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
                {editState.error ? <p className="text-[13px] text-red-600">{editState.error}</p> : null}
                {editState.savedAt ? (
                  <p className="text-[13px] text-green-700">Saved at {editState.savedAt}.</p>
                ) : null}

                <div className="flex gap-2">
                  <Button
                    onClick={save}
                    disabled={
                      editState.saving ||
                      issues.length > 0 ||
                      (!editState.subject.trim() && !editState.body.trim())
                    }
                  >
                    {editState.saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={resetToDefault}
                    disabled={editState.saving || !selected.override}
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
                          checked={sailingCascadeState.previewSource === value}
                          onChange={() => {
                            setSailingCascadeState((s) => ({ ...s, previewSource: value }));
                            setPreviewSendState((s) => ({ ...s, previewHtml: null }));
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

                {/* Sailing cascade dropdowns */}
                {sailingCascadeState.previewSource === "sailing" ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="block text-[13px] font-medium">Cruise Line</label>
                      <select
                        className="border border-gray-300 rounded h-9 px-3 text-sm bg-white"
                        value={sailingCascadeState.selectedLineId}
                        onChange={(e) => handleSailingLineChange(e.target.value)}
                      >
                        <option value="">— Select a cruise line —</option>
                        {sailingCascadeState.sailingLines.map((l) => (
                          <option key={l.id} value={l.id}>{l.display_name}</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="block text-[13px] font-medium">Ship</label>
                      <select
                        className="border border-gray-300 rounded h-9 px-3 text-sm bg-white disabled:opacity-50"
                        value={sailingCascadeState.selectedShipId}
                        onChange={(e) => handleSailingShipChange(e.target.value)}
                        disabled={!sailingCascadeState.selectedLineId || sailingCascadeState.loadingSailingShips}
                      >
                        <option value="">
                          {sailingCascadeState.loadingSailingShips
                            ? "Loading…"
                            : sailingCascadeState.selectedLineId
                            ? "— Select a ship —"
                            : "— Select a cruise line first —"}
                        </option>
                        {sailingCascadeState.sailingShips.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.canonical_name}{s.ship_class ? ` (${s.ship_class})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="block text-[13px] font-medium">Sail Date</label>
                      <select
                        className="border border-gray-300 rounded h-9 px-3 text-sm bg-white disabled:opacity-50"
                        value={sailingCascadeState.selectedSailingId}
                        onChange={(e) => handleSailingDateChange(e.target.value)}
                        disabled={!sailingCascadeState.selectedShipId || sailingCascadeState.loadingSailingOptions}
                      >
                        <option value="">
                          {sailingCascadeState.loadingSailingOptions
                            ? "Loading…"
                            : sailingCascadeState.selectedShipId
                            ? "— Select a sailing —"
                            : "— Select a ship first —"}
                        </option>
                        {sailingCascadeState.sailingOptions.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.departure_date} — {s.departure_port} — {s.duration_nights}n
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ) : null}

                {/* Booking search */}
                {sailingCascadeState.previewSource === "booking" ? (
                  <div>
                    <label className="block text-[13px] font-medium mb-1">
                      Search bookings by customer name
                    </label>
                    <input
                      className={TEXT_INPUT_CLS}
                      value={
                        bookingSearchState.selectedBooking
                          ? [
                              bookingSearchState.selectedBooking.primary_contact?.first_name,
                              bookingSearchState.selectedBooking.primary_contact?.last_name,
                            ]
                              .filter(Boolean)
                              .join(" ") +
                            (bookingSearchState.selectedBooking.ship_name
                              ? ` — ${bookingSearchState.selectedBooking.ship_name}`
                              : "")
                          : bookingSearchState.bookingQuery
                      }
                      onChange={(e) => {
                        setBookingSearchState((s) => ({
                          ...s,
                          selectedBooking: null,
                          bookingQuery: e.target.value,
                        }));
                        setPreviewSendState((s) => ({ ...s, previewHtml: null }));
                      }}
                      placeholder="Type a customer name…"
                    />
                    {bookingSearchState.bookingSearching ? (
                      <p className="text-[12px] text-muted-foreground mt-1">Searching…</p>
                    ) : null}
                    {!bookingSearchState.selectedBooking && bookingSearchState.bookingResults.length > 0 ? (
                      <ul className="border border-border rounded mt-1 divide-y divide-border max-h-[200px] overflow-y-auto">
                        {bookingSearchState.bookingResults.map((b) => {
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
                                  setBookingSearchState((s) => ({
                                    ...s,
                                    selectedBooking: b,
                                    bookingResults: [],
                                  }));
                                  setPreviewSendState((s) => ({ ...s, previewHtml: null }));
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
                                    ({formatDate(b.sailing_date, "medium")})
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    {bookingSearchState.selectedBooking ? (
                      <button
                        onClick={() => {
                          setBookingSearchState((s) => ({ ...s, selectedBooking: null, bookingQuery: "" }));
                          setPreviewSendState((s) => ({ ...s, previewHtml: null }));
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
                    disabled={!canOpenPreview || previewSendState.previewFetching}
                  >
                    {previewSendState.previewFetching ? "Loading…" : "Load preview"}
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
                      setPreviewSendState((s) => ({ ...s, sendDialogOpen: true, sendStatus: null }));
                    }}
                    disabled={!canOpenPreview}
                  >
                    Send to my email
                  </Button>
                </div>

                {/* Inline HTML preview iframe */}
                {previewSendState.previewHtml ? (
                  <div className="border border-border rounded overflow-hidden">
                    <iframe
                      srcDoc={previewSendState.previewHtml}
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
      {previewSendState.sendDialogOpen ? (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewSendState((s) => ({ ...s, sendDialogOpen: false }));
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
                value={previewSendState.sendToEmail}
                onChange={(e) => setPreviewSendState((s) => ({ ...s, sendToEmail: e.target.value }))}
                placeholder="you@youragency.com"
                maxLength={254}
                autoFocus
              />
            </div>
            {previewSendState.sendStatus ? (
              <p
                className={`text-[13px] ${previewSendState.sendStatus.ok ? "text-green-700" : "text-red-600"}`}
              >
                {previewSendState.sendStatus.message}
              </p>
            ) : null}
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setPreviewSendState((s) => ({ ...s, sendDialogOpen: false }))}
              >
                Close
              </Button>
              <Button
                onClick={sendPreview}
                disabled={previewSendState.sending || !previewSendState.sendToEmail.trim()}
              >
                {previewSendState.sending ? "Sending…" : "Send preview"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
