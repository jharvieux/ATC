// Code-side defaults for every persona, mapped to the DB-shaped PersonaRecord.
//
// Three consumers:
//   1. Seed source of truth — the personas-table migration seeds these values.
//   2. Restore-to-default — the admin API resets a persona/safety block to these.
//   3. Hot-path fallback — persona-repository falls back to these on DB miss/error
//      so chat never hard-fails on a transient read problem (the values are the
//      vetted baseline, and the legal kernel is always code-side regardless).
//
// The base-blocks keep their authoring shape (nested character/expertise_area);
// this module is the single adapter that flattens them into PersonaRecord. The
// travel personas all share one shape; help_ai is self-contained (platform_help).

import { personaBase as marcus } from "./base-blocks/marcus";
import { personaBase as marco } from "./base-blocks/marco";
import { personaBase as priya } from "./base-blocks/priya";
import { personaBase as dave } from "./base-blocks/dave";
import { personaBase as maya } from "./base-blocks/maya";
import { personaBase as jenny } from "./base-blocks/jenny";
import { personaBase as helpAi } from "./base-blocks/help-ai";
import {
  PERSONA_KIND_TRAVEL,
  PERSONA_KIND_PLATFORM_HELP,
  type PersonaRecord,
} from "./assemble-persona-prompt";

type TravelPersonaBase = {
  slug: string;
  display_name: string;
  tagline: string;
  specialty: string;
  character: { voice: string; background: string; tone_style: string };
  expertise_area: { primary: string; secondary: string; fallback_note?: string };
  anti_instructions: string[];
  tone_calibration_placeholder: string;
  disclosure_pattern: string;
  background: string;
  prompt_body: string;
};

type HelpPersonaBase = {
  slug: string;
  kind: "platform_help";
  display_name: string;
  tagline: string;
  specialty: string;
  tone_calibration_placeholder: string;
  prompt_body: string;
};

function fromTravelBase(base: TravelPersonaBase): PersonaRecord {
  return {
    slug: base.slug,
    kind: PERSONA_KIND_TRAVEL,
    display_name: base.display_name,
    tagline: base.tagline,
    specialty: base.specialty,
    background: base.background,
    voice: base.character.voice,
    tone_style: base.character.tone_style,
    expertise_primary: base.expertise_area.primary,
    expertise_secondary: base.expertise_area.secondary,
    expertise_fallback_note: base.expertise_area.fallback_note ?? null,
    anti_instructions: base.anti_instructions,
    disclosure_pattern: base.disclosure_pattern,
    prompt_body: base.prompt_body,
    tone_calibration_placeholder: base.tone_calibration_placeholder,
  };
}

function fromHelpBase(base: HelpPersonaBase): PersonaRecord {
  return {
    slug: base.slug,
    kind: PERSONA_KIND_PLATFORM_HELP,
    display_name: base.display_name,
    tagline: base.tagline,
    specialty: base.specialty,
    background: "",
    voice: null,
    tone_style: null,
    expertise_primary: null,
    expertise_secondary: null,
    expertise_fallback_note: null,
    anti_instructions: [],
    disclosure_pattern: null,
    prompt_body: base.prompt_body,
    tone_calibration_placeholder: base.tone_calibration_placeholder,
  };
}

// Ordered for seed sort_order: Marcus first (CATCHALL default), help_ai last.
export const PERSONA_DEFAULTS: PersonaRecord[] = [
  fromTravelBase(marcus),
  fromTravelBase(marco),
  fromTravelBase(priya),
  fromTravelBase(dave),
  fromTravelBase(maya),
  fromTravelBase(jenny),
  fromHelpBase(helpAi),
];

export function getPersonaDefault(slug: string): PersonaRecord | undefined {
  return PERSONA_DEFAULTS.find((p) => p.slug === slug);
}
