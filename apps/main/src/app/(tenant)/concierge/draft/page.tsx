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
  const [inquiry, setInquiry] = useState(() => search.get("inquiry") ?? "");
  const [subject, setSubject] = useState(() => search.get("subject") ?? "");
  const [customerName, setCustomerName] = useState(() => search.get("customerName") ?? "");
  const [personaSlug, setPersonaSlug] = useState<string>(AGENT_CATALOG[0]!.slug);
  const [personaTouched, setPersonaTouched] = useState(false);
  const [inquiryLoadError, setInquiryLoadError] = useState(false);

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
          if (!cancelled) setInquiryLoadError(true);
          return;
        }
        const data = (await res.json()) as { content?: string };
        if (!cancelled && data.content) setInquiry(data.content);
      } catch {
        if (!cancelled) setInquiryLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [contactId, messageId]);

  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState("");
  const [voiceMissing, setVoiceMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [copied, setCopied] = useState(false);

  // D-193 decision 4 — system suggests, TA confirms. The suggestion only
  // auto-selects until the TA touches the picker.
  const suggestion = useMemo(() => suggestPersona(inquiry), [inquiry]);
  const effectivePersona = personaTouched ? personaSlug : (suggestion?.slug ?? personaSlug);

  function applyParsed(p: ParsedInquiry): void {
    if (p.body) setInquiry(p.body);
    if (p.subject) setSubject(p.subject);
    const name = deriveGreetingName(p.from_name, p.from_email);
    setCustomerName(name ?? "");
  }

  async function generate(): Promise<void> {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/draft-reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inquiry,
          subject: subject || null,
          customer_name: customerName || null,
          persona_slug: effectivePersona,
        }),
      });
      if (res.status === 403) { setForbidden(true); return; }
      const data = (await res.json()) as { draft?: string; error?: string; voice_profile_missing?: boolean };
      if (!res.ok || !data.draft) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft(data.draft);
      setVoiceMissing(Boolean(data.voice_profile_missing));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function copyDraft(): Promise<void> {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
  }

  if (forbidden) {
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
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="[name] placeholder if left blank"
            className="w-full border border-border rounded-md px-3 py-1.5 text-[13px] mt-1 text-foreground"
          />
        </label>
        <label className="text-[12px] text-muted-foreground">
          Subject (optional)
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full border border-border rounded-md px-3 py-1.5 text-[13px] mt-1 text-foreground"
          />
        </label>
      </div>

      {inquiryLoadError && (
        <p className="text-[12px] text-red-700 dark:text-red-400 mb-3">
          Couldn&apos;t load the email body — paste it in below.
        </p>
      )}

      <label className="text-[12px] text-muted-foreground block mb-4">
        Customer inquiry
        <Textarea
          value={inquiry}
          onChange={(e) => setInquiry(e.target.value)}
          rows={8}
          placeholder="…or paste the customer's email here"
          className="text-[13px] mt-1"
        />
      </label>

      <div className="flex items-center gap-3 mb-5">
        <span className="text-[12px] text-muted-foreground whitespace-nowrap">Answer as</span>
        <Select
          value={effectivePersona}
          onValueChange={(v) => { setPersonaSlug(v); setPersonaTouched(true); }}
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
        {suggestion && !personaTouched && (
          <span className="text-[11px] text-muted-foreground">
            Suggested: {suggestion.name} ({suggestion.specialty})
          </span>
        )}
        <Button
          onClick={() => void generate()}
          disabled={generating || !inquiry.trim()}
          className="ml-auto h-8 px-4 text-[13px]"
        >
          {generating ? "Drafting…" : draft ? "Regenerate" : "Generate draft"}
        </Button>
      </div>

      {error && <p className="text-[12px] text-red-700 dark:text-red-400 mb-3">{error}</p>}

      {draft && (
        <section>
          {voiceMissing && (
            <p className="text-[12px] text-amber-700 dark:text-amber-400 mb-2">
              No voice profile yet — this draft uses a neutral tone.{" "}
              <a href="/settings/voice" className="underline">Add samples</a> so drafts sound like you.
            </p>
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            className="text-[13px] mb-2"
          />
          <Button onClick={() => void copyDraft()} variant="outline" className="h-8 px-4 text-[13px]">
            {copied ? "Copied ✓" : "Copy draft"}
          </Button>
        </section>
      )}
    </main>
  );
}
