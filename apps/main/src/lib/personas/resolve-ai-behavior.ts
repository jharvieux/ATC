// §9.10.1 — AI behavior flag resolver
// Every chat / extraction / ingestion / moderation path MUST call this
// and respect the returned flags before performing any AI operation.

export type AIMode = "autonomous" | "draft_only" | "disabled";

export type AIBehaviorFlags = {
  customer_chat_autonomous_response: boolean;
  customer_chat_draft_for_review: boolean;
  memory_extraction_enabled: boolean;
  persona_addendum_screening_enabled: boolean;
  rag_normalization_ai: "full" | "reduced" | "none";
  pre_cruise_email_personalization: "ai_generated" | "template_only";
  forum_moderation: "haiku_screened" | "coordinator_only";
  abuse_signal_screening_enabled: boolean;
};

type TenantAIConfig = {
  ai_mode: AIMode;
  background_ai_enabled: boolean;
};

export function resolveAIBehavior(tenant: TenantAIConfig): AIBehaviorFlags {
  const { ai_mode, background_ai_enabled } = tenant;

  // background_ai=OFF forces all background AI features off regardless of ai_mode
  if (!background_ai_enabled) {
    return {
      customer_chat_autonomous_response: ai_mode === "autonomous",
      customer_chat_draft_for_review: ai_mode === "draft_only",
      memory_extraction_enabled: false,
      persona_addendum_screening_enabled: false,
      rag_normalization_ai: "none",
      pre_cruise_email_personalization: "template_only",
      forum_moderation: "coordinator_only",
      abuse_signal_screening_enabled: false,
    };
  }

  // background_ai=ON — behavior depends on ai_mode
  switch (ai_mode) {
    case "autonomous":
      return {
        customer_chat_autonomous_response: true,
        customer_chat_draft_for_review: false,
        memory_extraction_enabled: true,
        persona_addendum_screening_enabled: true,
        rag_normalization_ai: "full",
        pre_cruise_email_personalization: "ai_generated",
        forum_moderation: "haiku_screened",
        abuse_signal_screening_enabled: true,
      };

    case "draft_only":
      return {
        customer_chat_autonomous_response: false,
        customer_chat_draft_for_review: true,
        memory_extraction_enabled: true,
        persona_addendum_screening_enabled: true,
        rag_normalization_ai: "full",
        pre_cruise_email_personalization: "ai_generated",
        forum_moderation: "haiku_screened",
        abuse_signal_screening_enabled: true,
      };

    case "disabled":
      // Customer chat AI fully off; all other background AI stays on per §9.10.1
      return {
        customer_chat_autonomous_response: false,
        customer_chat_draft_for_review: false,
        memory_extraction_enabled: true,
        persona_addendum_screening_enabled: true,
        rag_normalization_ai: "full",
        pre_cruise_email_personalization: "ai_generated",
        forum_moderation: "haiku_screened",
        abuse_signal_screening_enabled: true,
      };
  }
}
