# #904 — Phase 3 draft-reply composer: design

Status: DRAFT — pending operator approval of the runtime dependencies (the
one gate; see "Dependencies"). Design pass on fable/Opus-tier, 2026-06-10.
Phase 3 of the BYO dual-role persona track (D-193/D-194; builds on #902 TA
mode + #903 voice profiles, both shipped).

## Product decisions already locked (D-193/D-194)

- **Draft-only v1** — no send path anywhere; TA edits + copies into their own
  mail client. Send-on-behalf reopens only with #890 (inbound), not before.
- **Persona: TA picks, system suggests** — never fully automatic.
- **Intake: drag-and-drop first** — `.eml` (Apple Mail/Thunderbird drags),
  **`.msg` IN scope** (D-194, Outlook desktop), webmail text selections,
  paste fallback.
- **From → greeting** — parsed display-name drives the greeting in the TA's
  own greeting style; `[name]` placeholder when unknown — never silently
  guessed; parsed From always shown for correction before drafting.

## Architecture

### Intake — client-side parsing (privacy posture)

All email parsing happens **in the browser**; only the parsed fields
(`from_name`, `from_email`, `subject`, `body text`) ever reach the API. Raw
emails are never uploaded or stored.

`components/draft/InquiryDropZone.tsx` accepts, in priority order:

1. **Files** from `DataTransfer.files`:
   - `.eml` → `postal-mime` (browser-capable MIME parser): From
     (display-name + address, RFC 2047 encoded-words handled), Subject,
     text body (html→text fallback via its built-in conversion).
   - `.msg` → `@kenjiuno/msgreader` (browser-capable OLE2/CFB+MAPI reader):
     senderName/senderEmail/subject/body. **RTF-compressed bodies**: when
     `body` is absent but `compressedRtf` is present, decode via
     `@kenjiuno/decompressrtf` + de-encapsulation; if no usable text falls
     out, fall back gracefully — populate From/Subject and prompt the TA to
     paste the body (the D-194 contingency).
2. **Dragged webmail selections** — `text/plain` (preferred) or stripped
   `text/html` DataTransfer items. No headers exist → the name field is
   empty and the TA fills it.
3. **Paste** into the inquiry textarea — universal fallback.

Parsing lives in `lib/draft/parse-eml.ts` / `lib/draft/parse-msg.ts` (thin,
unit-tested wrappers; browser-only imports kept out of route code).
Greeting-name derivation (`lib/draft/greeting-name.ts`, pure):
display-name → first token title-cased; else mailbox local-part only if it
looks like a name (`sarah.mitchell` → `Sarah`, but `info`/`bookings`/
`noreply`/digits → no); else null → UI shows `[name]` and the draft
instruction says to keep the placeholder.

### Persona suggestion — code, not model (deviation, justified)

The issue sketched a Haiku call; D-193's product decision only requires
"cheap classification" with the TA confirming. **v1 uses a deterministic
keyword scorer** over the existing `AGENT_CATALOG` `quizTags` + specialty
terms (`lib/draft/suggest-persona.ts`): zero cost, zero latency, testable,
and per CLAUDE.md "if code can answer, code answers." Below-threshold → no
suggestion. A Haiku upgrade stays open as a follow-up if real-world routing
disappoints — the function signature won't change.

### Draft generation — `POST /api/draft-reply`

- **Auth:** `assertPermission(resource: "draft_reply", action: "create")`
  — new grant in AGENT_GRANTS (owner inherits; viewers excluded). Real
  assertPermission gate (not stub-shaped — this is the only auth layer for
  the route, unlike chat's resolveMemberIdentity path).
- **Body:** `{ inquiry: string, customer_name: string|null, persona_slug,
  subject?: string|null }` (≤8k chars inquiry, mirrors chat).
- **Prompt:** `buildSystemPrompt(audience: "tenant_member", persona_slug,
  knowledge_block: retrieveForChat(inquiry, customer_has_booking: true))` +
  a `VOICE PROFILE` block from `resolveVoiceProfile(db, callerPublicId)`
  (card_override preferred over style_card; null → neutral-professional +
  the response flags `voice_profile_missing: true` so the UI shows the
  settings nudge) + a DRAFT TASK block (write the reply, greeting per the
  TA's greeting convention using `customer_name` or the literal `[name]`,
  sign-off per card, no invented facts beyond the knowledge block).
- **Call:** `instrumentedClaudeCall` (non-streaming v1 — drafts are a few
  hundred tokens; a JSON response keeps the route small and testable;
  streaming is a UI follow-up), purpose **`draft_reply`** (new
  AICallPurpose; NOT customer-facing → accepts soft-tier downgrade; hard
  state refused by the wrapper - #866 closed both wrappers).
- **No DB writes**: drafts are ephemeral; cost lands in `ai_call_log`
  automatically. **Daily cap:** count today's `ai_call_log` rows with
  `purpose='draft_reply'` per (tenant, user) — fail-closed like the TA chat
  cap; default 100/day via `draft_reply_daily_cap` platform setting.

### UI — `(tenant)/concierge/draft/page.tsx`

Linked from the Concierge page header ("Draft a reply"). Layout: drop zone /
paste area → parsed-fields strip (From name editable, subject) → persona
select with the suggestion pre-highlighted ("Suggested: Captain Dave —
Alaska") → Generate → editable textarea + Copy button + regenerate. 403 →
same access-denied state as Concierge. No send button exists, by contract.

## Dependencies (operator gate — runtime deps)

| Package | Version | License | Size | Why |
|---|---|---|---|---|
| `postal-mime` | 2.7.4 | MIT-0 | ~285 KB | .eml MIME parsing in-browser (encoded-words, multipart, quoted-printable — hand-rolling these is the failure mode) |
| `@kenjiuno/msgreader` | 1.28.0 | Apache-2.0 | ~380 KB | .msg OLE2/MAPI — no credible hand-rolled alternative |
| `@kenjiuno/decompressrtf` | 0.1.4 | BSD-2 | ~8 KB | RTF-compressed .msg bodies |

All actively maintained (registry checked 2026-06-10). All three load
client-side only (dynamic import in the drop-zone component) — zero server
bundle impact. **Test fixtures:** a hand-authored `.eml` (it's a text
format) incl. an RFC 2047 encoded-word From; for `.msg`, vendor one small
Apache-2.0-licensed fixture from the msgreader repo's test suite (with
attribution comment) — an authentic Outlook-generated binary I cannot
fabricate honestly.

## Test plan

- `greeting-name`: display-name, encoded-word, local-part heuristics
  (sarah.mitchell→Sarah; info@/noreply@→null), null → placeholder contract.
- `parse-eml` / `parse-msg`: real fixtures incl. encoded-word From and an
  RTF-bodied .msg; .msg with no extractable body → From/Subject + null body
  (the graceful-fallback contract).
- `suggest-persona`: clear Alaska → captain-dave; luxury → priya; ambiguous
  → null (no suggestion beats wrong suggestion).
- Route: viewer 403; cap fail-closed; voice-profile-missing flag; prompt
  receives VOICE PROFILE block when profile exists (mock-level assert);
  draft text returned verbatim from the wrapper.
- No send path: grep-level test asserting the route module exports only
  POST and imports no email-sending module.

## Sequencing

Single PR (route + lib + UI + deps + tests) — cohesive feature, no
migration. New route + new deps → **Opus first-audit**. No prod DB
involvement at any step (no migration; settings key read with default).
