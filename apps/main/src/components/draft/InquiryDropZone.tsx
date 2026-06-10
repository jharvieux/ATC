"use client";

// #904 — drag-and-drop email intake for the draft composer.
// Accepts .eml / .msg files (parsed client-side — raw emails never leave the
// browser), dragged webmail text selections, and plain paste in the parent's
// textarea. Parsed fields flow up via onParsed; errors are shown inline.

import { useCallback, useState } from "react";
import { parseEmlFile, parseMsgFile, type ParsedInquiry } from "@/lib/draft/parse-inquiry";

export interface InquiryDropZoneProps {
  onParsed: (parsed: ParsedInquiry) => void;
}

export function InquiryDropZone({ onParsed }: InquiryDropZoneProps): React.JSX.Element {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setHover(false);
    setError(null);
    setBusy(true);
    try {
      const file = e.dataTransfer.files?.[0];
      if (file) {
        const name = file.name.toLowerCase();
        const buf = await file.arrayBuffer();
        if (name.endsWith(".eml")) {
          onParsed(await parseEmlFile(buf));
        } else if (name.endsWith(".msg")) {
          const parsed = await parseMsgFile(buf);
          onParsed(parsed);
          if (!parsed.body) {
            setError("Couldn't extract the message text from this .msg — please paste the body below.");
          }
        } else {
          setError("Drop a .eml or .msg file, or drag the email text itself.");
        }
        return;
      }
      // Webmail selection drag — no headers; the TA fills the name.
      const text = e.dataTransfer.getData("text/plain")
        || stripTags(e.dataTransfer.getData("text/html"));
      if (text.trim()) {
        onParsed({ from_name: null, from_email: null, subject: null, body: text.trim() });
        return;
      }
      setError("Nothing readable in that drop — try dragging the email file or its text.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onParsed]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => void handleDrop(e)}
      className={`border-2 border-dashed rounded-lg px-4 py-6 text-center text-[13px] transition-colors ${
        hover ? "border-primary bg-accent" : "border-border text-muted-foreground"
      }`}
    >
      {busy
        ? "Reading…"
        : "Drag a customer email here (.eml from Apple Mail / Thunderbird, .msg from Outlook, or selected text from webmail)"}
      {error && <p className="text-red-700 dark:text-red-400 text-[12px] mt-2 mb-0">{error}</p>}
    </div>
  );
}

function stripTags(html: string): string {
  return html ? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}
