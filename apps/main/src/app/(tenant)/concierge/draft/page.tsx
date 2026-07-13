"use client";

// #904 / D-193 Phase 3 — draft a customer reply in the TA's voice.
// Draft-only by contract: there is no send button on this page and no send
// path in the API. The TA edits and copies into their own mail client.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { InquiryDropZone } from "@/components/draft/InquiryDropZone";
import type { ParsedInquiry } from "@/lib/draft/parse-inquiry";
import { deriveGreetingName } from "@/lib/draft/greeting-name";
import { suggestPersona } from "@/lib/draft/suggest-persona";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// #1812 — the 13 useState hooks (inquiry form fields + draft-generation
// result) are grouped into 2 state objects by concern, one useState each,
// matching the pattern established in #1791.
interface FormState {
  inquiry: string;
  subject: string;
  customerName: string;
  personaSlug: string;
  personaTouched: boolean;
  inquiryLoadError: boolean;
}

interface DraftResultState {
  generating: boolean;
  draft: string;
  voiceMissing: boolean;
  error: string | null;
  forbidden: boolean;
  copied: boolean;
}

export default function DraftReplyPage(): React.JSX.Element {
  // useSearchParams needs a Suspense boundary (Next.js). #1728 — the CRM
  // timeline's "Draft reply" action deep-links here with the inbound body
  // pre-filled; this stays draft-only (no email import, no send path).
  return (
    <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
      <DraftReplyForm />
    </Suspense>
  );
}

function DraftReplyForm(): React.JSX.Element {
  const search = useSearchParams();
  const contactId = search.get("contactId");
  const messageId = search.get("messageId");
  const [form, setForm] = useState<FormState>(() => ({
    inquiry: search.get("inquiry") ?? "",
    subject: search.get("subject") ?? "",
    customerName: search.get("customerName") ?? "",
    personaSlug: AGENT_CATALOG[0]!.slug,
    personaTouched: false,
    inquiryLoadError: false,
  }));
  const [result, setResult] = useState<DraftResultState>({
    generating: false, draft: "", voiceMissing: false, error: null, forbidden: false, copied: false,
  });

  // #1756 — the CRM deep link passes contactId/messageId instead of the full
  // body (a long inbound email can exceed browser/proxy URL length limits
  // via ?inquiry=<body> and silently truncate the pre-fill). Fetch the body
  // here instead.
  useEffect(() => {
    if (!contactId || !messageId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/crm/contacts/${contactId}/messages/${messageId}`);
        if (!res.ok) {
          if (!cancelled) setForm((f) => ({ ...f, inquiryLoadError: true }));
          return;
        }
        const data = (await res.json()) as { content?: string };
        if (!cancelled && data.content) setForm((f) => ({ ...f, inquiry: data.content! }));
      } catch {
        if (!cancelled) setForm((f) => ({ ...f, inquiryLoadError: true }));
      }
    })();
    return () => { cancelled = true; };
  }, [contactId, messageId]);

  // D-193 decision 4 — system suggests, TA confirms. The suggestion only
  // auto-selects until the TA touches the picker.
  const suggestion = useMemo(() => suggestPersona(form.inquiry), [form.inquiry]);
  const effectivePersona = form.personaTouched ? form.personaSlug : (suggestion?.slug ?? form.personaSlug);

  function applyParsed(p: ParsedInquiry): void {
    const name = deriveGreetingName(p.from_name, p.from_email);
    setForm((f) => ({
      ...f,
      inquiry: p.body ?? f.inquiry,
      subject: p.subject ?? f.subject,
      customerName: name ?? "",
    }));
  }

  async function generate(): Promise<void> {
    setResult((r) => ({ ...r, generating: true, error: null, copied: false }));
    try {
      const res = await fetch("/api/draft-reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inquiry: form.inquiry,
          subject: form.subject || null,
          customer_name: form.customerName || null,
          persona_slug: effectivePersona,
        }),
      });
      if (res.status === 403) { setResult((r) => ({ ...r, forbidden: true })); return; }
      const data = (await res.json()) as { draft?: string; error?: string; voice_profile_missing?: boolean };
      if (!res.ok || !data.draft) {
        setResult((r) => ({ ...r, error: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      setResult((r) => ({ ...r, draft: data.draft!, voiceMissing: Boolean(data.voice_profile_missing) }));
    } catch (e) {
      setResult((r) => ({ ...r, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setResult((r) => ({ ...r, generating: false }));
    }
  }

  async function copyDraft(): Promise<void> {
    await navigator.clipboard.writeText(result.draft);
    setResult((r) => ({ ...r, copied: true }));
  }

  if (result.forbidden) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center mt-16">
        <h1 className="text-xl font-semibold mb-2">Access restricted</h1>
        <p className="text-muted-foreground text-sm">
          Drafting is available to team members (Owner or Agent role).
        </p>
      </div>
    );
  }

  return (
    <main className="px-6 py-8 max-w-[820px] mx-auto">
      <h1 className="text-2xl font-bold mb-1">Draft a reply</h1>
      <p className="text-muted-foreground text-[14px] mb-6">
        Drop a customer email or paste the inquiry — the AI drafts a reply in your voice.
        Nothing is sent: you copy the draft into your own email.
      </p>

      <InquiryDropZone onParsed={applyParsed} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 mb-3">
        <label className="text-[12px] text-muted-foreground">
          Customer first name (for the greeting)
          <input
            type="text"
            value={form.customerName}
            onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
            placeholder="[name] placeholder if left blank"
            className="w-full border border-border rounded-md px-3 py-1.5 text-[13px] mt-1 text-foreground"
          />
        </label>
        <label className="text-[12px] text-muted-foreground">
          Subject (optional)
          <input
            type="text"
            value={form.subject}
            onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
            className="w-full border border-border rounded-md px-3 py-1.5 text-[13px] mt-1 text-foreground"
          />
        </label>
      </div>

      {form.inquiryLoadError && (
        <p className="text-[12px] text-red-700 dark:text-red-400 mb-3">
          Couldn&apos;t load the email body — paste it in below.
        </p>
      )}

      <label className="text-[12px] text-muted-foreground block mb-4">
        Customer inquiry
        <Textarea
          value={form.inquiry}
          onChange={(e) => setForm((f) => ({ ...f, inquiry: e.target.value }))}
          rows={8}
          placeholder="…or paste the customer's email here"
          className="text-[13px] mt-1"
        />
      </label>

      <div className="flex items-center gap-3 mb-5">
        <span className="text-[12px] text-muted-foreground whitespace-nowrap">Answer as</span>
        <Select
          value={effectivePersona}
          onValueChange={(v) => setForm((f) => ({ ...f, personaSlug: v, personaTouched: true }))}
        >
          <SelectTrigger className="h-8 text-[12px] w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {AGENT_CATALOG.map((a) => (
              <SelectItem key={a.slug} value={a.slug} className="text-[12px]">
                {a.name} · {a.specialty}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {suggestion && !form.personaTouched && (
          <span className="text-[11px] text-muted-foreground">
            Suggested: {suggestion.name} ({suggestion.specialty})
          </span>
        )}
        <Button
          onClick={() => void generate()}
          disabled={result.generating || !form.inquiry.trim()}
          className="ml-auto h-8 px-4 text-[13px]"
        >
          {result.generating ? "Drafting…" : result.draft ? "Regenerate" : "Generate draft"}
        </Button>
      </div>

      {result.error && <p className="text-[12px] text-red-700 dark:text-red-400 mb-3">{result.error}</p>}

      {result.draft && (
        <section>
          {result.voiceMissing && (
            <p className="text-[12px] text-amber-700 dark:text-amber-400 mb-2">
              No voice profile yet — this draft uses a neutral tone.{" "}
              <a href="/settings/voice" className="underline">Add samples</a> so drafts sound like you.
            </p>
          )}
          <Textarea
            value={result.draft}
            onChange={(e) => setResult((r) => ({ ...r, draft: e.target.value }))}
            rows={14}
            className="text-[13px] mb-2"
          />
          <Button onClick={() => void copyDraft()} variant="outline" className="h-8 px-4 text-[13px]">
            {result.copied ? "Copied ✓" : "Copy draft"}
          </Button>
        </section>
      )}
    </main>
  );
}
