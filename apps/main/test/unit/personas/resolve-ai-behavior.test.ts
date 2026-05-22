// Unit tests for resolveAIBehavior — §9.10.1
// Covers all 8 combinations (2 background × 3 ai_mode) + extra edge cases.
// These tests encode WHY each flag matters: a regression here means an AI
// operation ran when it should have been blocked (or vice versa).

import { describe, it, expect } from "vitest";
import { resolveAIBehavior } from "@/lib/personas/resolve-ai-behavior";

describe("resolveAIBehavior", () => {
  // ── background_ai=ON ───────────────────────────────────────────────────────

  describe("background_ai=ON + ai_mode=autonomous", () => {
    const flags = resolveAIBehavior({ ai_mode: "autonomous", background_ai_enabled: true });

    it("autonomous chat response is ON", () => {
      expect(flags.customer_chat_autonomous_response).toBe(true);
    });
    it("draft mode is OFF (autonomous overrides draft)", () => {
      expect(flags.customer_chat_draft_for_review).toBe(false);
    });
    it("memory extraction is ON", () => {
      expect(flags.memory_extraction_enabled).toBe(true);
    });
    it("persona screening is ON", () => {
      expect(flags.persona_addendum_screening_enabled).toBe(true);
    });
    it("RAG normalization is full", () => {
      expect(flags.rag_normalization_ai).toBe("full");
    });
    it("email personalization is ai_generated", () => {
      expect(flags.pre_cruise_email_personalization).toBe("ai_generated");
    });
    it("forum moderation is haiku_screened", () => {
      expect(flags.forum_moderation).toBe("haiku_screened");
    });
    it("abuse screening is ON", () => {
      expect(flags.abuse_signal_screening_enabled).toBe(true);
    });
  });

  describe("background_ai=ON + ai_mode=draft_only", () => {
    const flags = resolveAIBehavior({ ai_mode: "draft_only", background_ai_enabled: true });

    it("autonomous chat response is OFF", () => {
      expect(flags.customer_chat_autonomous_response).toBe(false);
    });
    it("draft for review is ON", () => {
      expect(flags.customer_chat_draft_for_review).toBe(true);
    });
    it("memory extraction is ON", () => {
      expect(flags.memory_extraction_enabled).toBe(true);
    });
    it("persona screening is ON", () => {
      expect(flags.persona_addendum_screening_enabled).toBe(true);
    });
    it("RAG normalization is full", () => {
      expect(flags.rag_normalization_ai).toBe("full");
    });
    it("email personalization is ai_generated", () => {
      expect(flags.pre_cruise_email_personalization).toBe("ai_generated");
    });
    it("forum moderation is haiku_screened", () => {
      expect(flags.forum_moderation).toBe("haiku_screened");
    });
    it("abuse screening is ON", () => {
      expect(flags.abuse_signal_screening_enabled).toBe(true);
    });
  });

  describe("background_ai=ON + ai_mode=disabled", () => {
    const flags = resolveAIBehavior({ ai_mode: "disabled", background_ai_enabled: true });

    it("autonomous chat response is OFF — this is the whole point of disabled mode", () => {
      expect(flags.customer_chat_autonomous_response).toBe(false);
    });
    it("draft for review is OFF — disabled means no AI in customer-facing chat at all", () => {
      expect(flags.customer_chat_draft_for_review).toBe(false);
    });
    it("memory extraction stays ON — disabled only affects customer chat per §9.10.1", () => {
      expect(flags.memory_extraction_enabled).toBe(true);
    });
    it("persona screening stays ON", () => {
      expect(flags.persona_addendum_screening_enabled).toBe(true);
    });
    it("RAG normalization stays full", () => {
      expect(flags.rag_normalization_ai).toBe("full");
    });
    it("email personalization stays ai_generated", () => {
      expect(flags.pre_cruise_email_personalization).toBe("ai_generated");
    });
    it("forum moderation stays haiku_screened", () => {
      expect(flags.forum_moderation).toBe("haiku_screened");
    });
    it("abuse screening stays ON", () => {
      expect(flags.abuse_signal_screening_enabled).toBe(true);
    });
  });

  // ── background_ai=OFF ──────────────────────────────────────────────────────
  // background_ai=OFF forces all background features off regardless of ai_mode.
  // Customer chat respects ai_mode independently.

  describe("background_ai=OFF + ai_mode=autonomous", () => {
    const flags = resolveAIBehavior({ ai_mode: "autonomous", background_ai_enabled: false });

    it("autonomous chat still ON — background_ai does not control customer chat", () => {
      expect(flags.customer_chat_autonomous_response).toBe(true);
    });
    it("draft is OFF (autonomous mode)", () => {
      expect(flags.customer_chat_draft_for_review).toBe(false);
    });
    it("memory extraction is OFF — background_ai=OFF kills all background features", () => {
      expect(flags.memory_extraction_enabled).toBe(false);
    });
    it("persona screening is OFF — cannot screen addendums without background AI", () => {
      expect(flags.persona_addendum_screening_enabled).toBe(false);
    });
    it("RAG normalization is none", () => {
      expect(flags.rag_normalization_ai).toBe("none");
    });
    it("email personalization is template_only", () => {
      expect(flags.pre_cruise_email_personalization).toBe("template_only");
    });
    it("forum moderation is coordinator_only", () => {
      expect(flags.forum_moderation).toBe("coordinator_only");
    });
    it("abuse screening is OFF", () => {
      expect(flags.abuse_signal_screening_enabled).toBe(false);
    });
  });

  describe("background_ai=OFF + ai_mode=draft_only", () => {
    const flags = resolveAIBehavior({ ai_mode: "draft_only", background_ai_enabled: false });

    it("autonomous is OFF", () => {
      expect(flags.customer_chat_autonomous_response).toBe(false);
    });
    it("draft is ON — background_ai does not control customer chat", () => {
      expect(flags.customer_chat_draft_for_review).toBe(true);
    });
    it("memory extraction is OFF", () => {
      expect(flags.memory_extraction_enabled).toBe(false);
    });
    it("RAG normalization is none", () => {
      expect(flags.rag_normalization_ai).toBe("none");
    });
  });

  describe("background_ai=OFF + ai_mode=disabled", () => {
    const flags = resolveAIBehavior({ ai_mode: "disabled", background_ai_enabled: false });

    it("autonomous is OFF", () => {
      expect(flags.customer_chat_autonomous_response).toBe(false);
    });
    it("draft is OFF", () => {
      expect(flags.customer_chat_draft_for_review).toBe(false);
    });
    it("memory extraction is OFF", () => {
      expect(flags.memory_extraction_enabled).toBe(false);
    });
    it("persona screening is OFF", () => {
      expect(flags.persona_addendum_screening_enabled).toBe(false);
    });
    it("RAG normalization is none", () => {
      expect(flags.rag_normalization_ai).toBe("none");
    });
    it("email personalization is template_only", () => {
      expect(flags.pre_cruise_email_personalization).toBe("template_only");
    });
    it("forum moderation is coordinator_only", () => {
      expect(flags.forum_moderation).toBe("coordinator_only");
    });
    it("abuse screening is OFF", () => {
      expect(flags.abuse_signal_screening_enabled).toBe(false);
    });
  });
});
