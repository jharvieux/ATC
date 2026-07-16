# Persona domain fact-check — 2026-07

**Date:** 2026-07-16
**Scope:** the six travel-persona base-blocks (`apps/main/src/lib/personas/base-blocks/`), their `customer_bio` fields, and the `AGENT_CATALOG` fallback bios.
**Method:** six parallel research agents verified every checkable domain claim in the persona prompts against primary sources (cruise line official pages, NPS/CBP/UNESCO, port authorities, reputable cruise trade press) as of July 2026. Character/backstory content stayed faithful to `specs/Agent Backstories Photo Guide v2.docx` (see `persona-backstory-alignment-report.md` — still valid for the biography dimension).

**Operator direction:** pre-existing prompt content that contradicted verified findings was to be replaced ("initial drafts by inferior models that contain errors"). Migration `20260722000024_persona_prompt_truth_pass.sql` intentionally overwrites the DB rows.

## Corrections applied (by persona)

### Marcus Cole (Caribbean)
- **St. Maarten is a dock port** (A.C. Wathey pier), not a tender port — was flatly wrong.
- St. Thomas claim reframed to the factual $1,600 USVI duty-free exemption (vs $800 standard).
- Grand Cayman: still tender-only (pier project dead); added rough-seas missed-port risk.
- Mount Gay: "oldest continuously operating commercial rum brand (deed 1703)", not "oldest rum brand."
- NCL Studio-cabin ship list corrected to the 10 ships that actually have Studios + Studio Lounge; Joy's "Solo" cabins explicitly distinguished (no lounge).
- Private-island landscape refreshed: Celebration Key (07/2025), Royal Beach Club Paradise Island (12/2025, paid day club), Great Stirrup Cay pier saga, RelaxAway Half Moon Cay rename + pier, Lookout Cay, Labadee suspended.
- Icon-class now three ships (Legend of the Seas to Fort Lauderdale late 2026); Maho Beach jet-blast safety warning added.

### Marco Bellini (Mediterranean & Rivers)
- Trattoria da Nennella **moved to Piazza Carità in Dec 2023** (was recommended at its old Quartieri Spagnoli address).
- Pinotxo **moved to Mercat de Sant Antoni (2023)**; old Boqueria stall trades under another name.
- Dubrovnik: now capped at 2 ships/~4,000 pax/day (the old "8,000/day" is the pre-agreement peak).
- Kotor: ~1,350 steps (not 1,500); Vranac is Montenegro's signature grape but not exclusive to it.
- Circumvesuviana fare corrected (~EUR 3.30 one-way, not "EUR 4 return"); Pompei Scavi stop + Campania Express + Pompeii visitor cap added.
- Added the 2025-2026 regulatory layer: Santorini 8,000/day cap, Greek per-passenger cruise tax, Cannes/Nice limits, Amsterdam cuts, Venice docking reality (Marghera/Ravenna/Trieste), Mykonos mostly docks now, timed entry at Acropolis/Pompeii/Sagrada Família, EES/ETIAS.
- Rhine/Danube late-summer low-water risk added (top river-cruise complaint).

### Priya Sharma (Luxury)
- **Regent no longer bundles airfare** (unbundled July 2024; "Air Concierge" since April 2026) — prompt claimed included business-class air.
- **Silversea retired Door-to-Door/Port-to-Port fares (Sept 2025)** → All-Inclusive Plus / All-Inclusive / Last Minute; classic-voyage excursions no longer auto-included (expeditions still are).
- **Celebrity butlers fully restored to all suites (May 2024)**; Retreat Sundeck is not fleet-wide.
- **Seabourn is a 5-ship fleet** (Odyssey + Sojourn sold to Mitsui; Quest retained).
- Haven realistic pricing ~$6,000-30,000+/couple (was $3,000 floor — off ~2x); Jewel-class *does* have a Haven (no restaurant/lounge); Aqua carries the newest largest Haven.
- RC Suite Class list includes Utopia + all Icon-class; Sea Class gets space-available Coastal Kitchen dinner.
- Viking: has theater revues (not "no shows"); added daily service charge in 2026; price gap vs Silversea narrowed.
- Oceania: Pépin is emeritus; Vista/Allura are current ships.
- New entrants section added: Explora Journeys, Ritz-Carlton Yacht Collection, Four Seasons Yachts, Crystal (A&K).

### Captain Dave (Alaska)
- Glacier Bay has **7 tidewater glaciers** (not 16); 2-ship/day NPS limit; **access is line-specific** (Princess/HAL/NCL/Carnival/Seabourn hold permits; RC/Celebrity generally substitute) — new "pick the itinerary by park name" rule.
- College Fjord: "a dozen-odd" college-named glaciers via the 1899 Harriman Expedition (not "26 named / Ivy League").
- **Anan Wildlife Observatory is near Wrangell and is primarily black bears** (was "Ketchikan / brown bears"); permit scarcity added. Brown bears: Icy Strait Point/Hoonah, Kodiak.
- **Mendenhall receded out of Mendenhall Lake (Nov 2025)**; "walk to the glacier face" removed.
- Sitka mostly docks at the Sitka Sound terminal ~5 mi out (was "tender port").
- Skagway Railroad Dock pedestrian closure (since 2022), Victoria short-evening-call warning + PVSA rationale, May/June driest months, Alaskan Dream Cruises shutdown (02/2026), Juneau daily caps, Tracy Arm → Endicott Arm reality, Denali cruisetour pairing.

### Maya Patel (Accessible)
- FAC/ambulatory/hearing 3-type cabin taxonomy attributed correctly to **Carnival-family lines**; RC/NCL sell a single accessible category — concepts kept, labels corrected.
- **Norwegian Aqua: 42 accessible staterooms (1 Haven)**, not "49 across all categories."
- **Great Stirrup Cay is tendering again** during 2026 pier expansion — replaced "no more tendering" with check-per-sailing guidance.
- Accessible/roll-on tendering fleets = **Holland America + Celebrity (Magic Carpet, with weight/size caps)** — HAL differentiator added; tender boarding framed as captain's-discretion, never guaranteed.
- Forms window corrected to 30-60 days (interpreters 60-90), not "45-90."
- Unverifiable "sensory rooms on newer ships" cut; verified sensory programs added (Carnival KultureCity fleet-wide + Celebration Key first certified destination; RC/Celebrity Autism on the Seas).
- ESAs: **no major line accepts them now**; CDC dog-import form + per-port permits added. Oxygen (liquid banned), Dialysis at Sea, medication refrigeration, Scootaround-by-WHILL naming, Santorini 587-steps/cable-car second barrier, accessible-excursion brokers (Wheel the World).

### Jenny Hartwell (Family)
- **Disney fleet is 8 ships** (was "only 6"); Oceaneer Club is ages 3-10 (was "3-8"); Rapunzel's Royal Table is **Disney Magic only**; Pirate Night fireworks itinerary-dependent.
- **"~27% more than RC" replaced** with the defensible 40-100%+ range (~2x on short Bahamas) + all-in-math guidance.
- Adventure Ocean structure updated (AO Juniors/Kids on newer ships, teen spaces vary by ship, late-night fee after ~10pm); "Fuel = 15-17 club" removed.
- **Carnival Camp Ocean takes age 2** (only big-three line below 3); Penguins/Stingrays/Sharks bands fixed; "80% of the experience at 60-65% of the price" replaced with "often 20-40% below RC."
- **NCL has no drop-off nursery** — under-3 decision tree added (RC/Disney/MSC have nurseries).
- Teen club names fixed (Disney Edge 11-14 / Vibe 14-17; NCL Entourage 13-17); MSC kids-locator described accurately (paid wristband, zone-level, smart ships); kids-sail-free promo caveats; private-destination-decides-short-Bahamas guidance.

## Cross-cutting changes
- `customer_bio` + `AGENT_CATALOG` bios rewritten to match the documented backstories (Priya's "Taj Mahal Palace", Marco's "Venice and Bari", Dave's "ran expedition ships" all contradicted the docx).
- New code-side `KNOWLEDGE_FRESHNESS_BLOCK` (assemble-persona-prompt.ts) appended to every travel persona: baked-in knowledge is "as of mid-2026" working knowledge; retrieved knowledge/pricing/lookup blocks always win; never state prices/availability/schedules from memory; flag possibly-changed details and offer to verify.
- Each persona gained a "never quote X from memory as current" anti-rule matched to its domain's volatility (fees/caps for Marco, inclusions for Priya, promo terms for Jenny, etc.).

## Maintenance note
These facts have a vintage (July 2026). When refreshing personas again: re-verify anything in the categories that moved this round — port infrastructure (piers/tenders), fare-structure inclusions, fleet counts, program names/age bands, and overtourism regulations. The docx (`specs/Agent Backstories Photo Guide v2.docx`) remains the source of truth for CHARACTER; it is **not** authoritative for domain facts — several of its embedded prompt claims were wrong at publication.
