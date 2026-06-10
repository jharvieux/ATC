// #904 / D-194 — parse a dropped email file into the draft composer's fields.
//
// Runs CLIENT-SIDE (privacy posture: only the parsed fields ever reach the
// API; raw emails are never uploaded). The parser packages are dynamically
// imported so they stay out of every other bundle — and out of the server
// build entirely. Unit tests exercise these in node (both packages are
// environment-agnostic).

export interface ParsedInquiry {
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  /** Plain-text body, or null when nothing extractable (D-194 fallback:
   *  populate From/Subject and ask the TA to paste the body). */
  body: string | null;
}

export async function parseEmlFile(buf: ArrayBuffer): Promise<ParsedInquiry> {
  const { default: PostalMime } = await import("postal-mime");
  const email = await new PostalMime().parse(buf);
  const from = email.from ?? null;
  // text part preferred; html-only emails go through real DOM parsing.
  const body = (email.text ?? "").trim() || htmlToText(email.html ?? "") || null;
  return {
    from_name: from?.name?.trim() || null,
    from_email: from?.address?.trim() || null,
    subject: email.subject?.trim() || null,
    body,
  };
}

export async function parseMsgFile(buf: ArrayBuffer): Promise<ParsedInquiry> {
  const { default: MsgReader } = await import("@kenjiuno/msgreader");
  const data = new MsgReader(buf).getFileData();

  let body = (data.body ?? "").trim() || null;
  if (!body && data.compressedRtf) {
    // .msg often stores the body as compressed RTF only (D-194's known
    // wrinkle). Decompress and strip the RTF down to text; if nothing
    // legible falls out, return null body — the UI asks for a paste.
    try {
      const { decompressRTF } = await import("@kenjiuno/decompressrtf");
      const rtfBytes = decompressRTF(Array.from(data.compressedRtf as Uint8Array));
      body = rtfToText(new TextDecoder("latin1").decode(Uint8Array.from(rtfBytes))) || null;
    } catch {
      body = null;
    }
  }

  return {
    from_name: data.senderName?.trim() || null,
    from_email: data.senderEmail?.trim() || null,
    subject: data.subject?.trim() || null,
    body,
  };
}

// Real HTML parsing via DOMParser — this module runs client-side, so no
// hand-rolled regex sanitizer (the pattern CodeQL rightly distrusts: tag and
// entity replacement is unfixable by regex). In non-DOM environments (unit
// tests run in node) html-only bodies yield "" → null body → the UI's
// paste-the-body fallback, the same contract as an unparseable .msg.
function htmlToText(html: string): string {
  if (!html || typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.textContent ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Minimal RTF→text: drop control words/groups, decode \'hh escapes, honor
// \par as newline. Good enough for "give the TA editable text"; a garbled
// result is recoverable because the textarea is editable and the paste
// fallback always exists.
function rtfToText(rtf: string): string {
  let s = rtf
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
    .replace(/[{}]/g, "");
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}
