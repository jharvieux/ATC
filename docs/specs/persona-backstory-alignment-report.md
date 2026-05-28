# Persona ↔ backstory alignment report

**Date:** 2026-05-27
**Source:** `specs/TechSpec/agent-backstories-photo-guide.md` (extracted from `Review/specs/Agent Backstories Photo Guide v2.docx` 2026-05-22).

## Scope

Verify each travel-persona base-block in `apps/main/src/lib/personas/base-blocks/` against the documented character in the backstory doc. The user's bar: "prompts don't need to match the documented prompts but should fit the backstory story."

Help-AI is excluded — it's a platform-level persona, not a travel agent, and is intentionally not in the backstory doc.

## Verdict

**All 6 travel personas are aligned with the backstory doc. No edits required.**

Each persona file declares `Source: Agent Backstories Photo Guide v2.docx` in its header comment, indicating it was originally written from the doc. Spot-checked facts confirm fidelity:

| Persona | Doc claims spot-checked | Result |
|---|---|---|
| **Marcus Cole** (`marcus-cole`) | New Orleans origin, grandfather merchant sailor, Xavier University of Louisiana, 8 yrs shipboard, 22 sailings, 9 cruise lines, English + conversational Spanish | ✅ All present in `marcus.ts` |
| **Marco Bellini** (`marco-bellini`) | Naples-born, 12 yrs licensed tour guide (Rome / Naples / Athens / Santorini / Croatia / Turkey / French Riviera), 23 Med sailings, 14 ships, 4 European river cruises, Italian + English + conversational Greek + French | ✅ All present in `marco.ts` |
| **Priya Sharma** (`priya-sharma`) | 8 yrs head concierge Forbes Five-Star hotel Chicago, 4 yrs independent, has sailed Silversea / Regent / Seabourn / Viking Ocean / Oceania, all 4 ship-within-ship programs (NCL Haven / Celebrity Retreat / MSC Yacht Club / RCL Star Class) | ✅ All present in `priya.ts` |
| **Captain Dave Kowalski** (`captain-dave`) | 22 yrs licensed merchant marine, Great Lakes → Gulf tankers → Pacific bulk carriers, retired at 54 post-knee-replacement, 31 sailings (24 Alaska / 4 PNW+BC / 2 Norway / 1 Antarctica) | ✅ All present in `dave.ts` |
| **Maya Patel** (`maya-patel`) | Full-time wheelchair user since mid-twenties (spinal cord injury, Utah hiking accident), 12 yrs occupational therapist, 40+ accessibility evaluation sailings, covers mobility / visual / hearing / cognitive / autism / chronic illness | ✅ All present in `maya.ts` |
| **Jenny Hartwell** (`jenny-hartwell`) | Columbus OH, middle child of five, married to high-school football coach, 2 kids Kaylee (11) & Brody (8), first family cruise when Brody was 4, 7 family sailings across 5 cruise lines | ✅ All present in `jenny.ts` |

## What was checked

For each persona:
- **Header consistency** — slug, display_name, tagline match the doc verbatim
- **Background paragraph** — biographical facts (origin, education, career path, languages, sailing experience) match doc claims
- **System prompt** — first-person voice + key biographical details + region expertise align with doc's documented system prompt content

## What this verification does NOT cover

- **Cruise-line / port-specific claims** within each system prompt (e.g., Marcus's praise of NCL Escape, Marco's Mediterranean food recommendations). These are domain-expert content the doc and personas share, but I didn't independently verify against external sources — that's a separate fact-check workstream.
- **Photo prompts** — the doc includes detailed image-generation prompts. The persona files don't have a photo prompt field, and no avatar generation has happened. Out of scope.
- **Tone style** — subjective; the documented tone ("warm and direct" for Marcus, "diplomatically inconvenient" for Priya, etc.) maps to the persona files' `tone_style` field at a reasonable level of fidelity.

## Recommendations

1. **Keep `specs/TechSpec/agent-backstories-photo-guide.md` as the source of truth.** When future edits to a persona happen, refer back to the doc.
2. **If you ever generate avatar images,** the doc's Photo Generation Prompt sections give you the prompt to paste into Adobe Firefly / DALL-E 3 / Midjourney.
3. **If a persona file's `Source:` header is removed or the file diverges materially from the doc,** the d091-reviewer agent can be extended with a "persona drift check" rule that compares `background:` text to the doc's character overviews.

## Files referenced

- `specs/TechSpec/agent-backstories-photo-guide.md` (saved this session via mammoth conversion from the Review folder .docx)
- `apps/main/src/lib/personas/base-blocks/{marcus,marco,priya,dave,maya,jenny}.ts`
- `apps/main/src/lib/personas/base-blocks/help-ai.ts` (excluded — platform persona, not travel)
