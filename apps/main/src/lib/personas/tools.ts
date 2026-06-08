// §9.6 — Tool-use registry stubs
// These define the tool metadata for the Claude API tool_use feature.
// Runtime handlers that actually invoke these tools land in later prompts.

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const PERSONA_TOOLS: ToolDefinition[] = [
  {
    name: "search_host_inventory",
    description:
      "Search the host agency's cruise inventory for available sailings matching customer criteria.",
    input_schema: {
      type: "object",
      properties: {
        // TODO(prompt-14): Replace with real host adapter schema
        destination: { type: "string", description: "Destination region or port" },
        departure_date_from: { type: "string", description: "Earliest departure date (ISO 8601)" },
        departure_date_to: { type: "string", description: "Latest departure date (ISO 8601)" },
        duration_nights_min: { type: "integer", description: "Minimum cruise duration in nights" },
        duration_nights_max: { type: "integer", description: "Maximum cruise duration in nights" },
        cruise_line: { type: "string", description: "Cruise line name filter (optional)" },
        ship_name: { type: "string", description: "Ship name filter (optional)" },
        max_results: { type: "integer", description: "Max results to return", default: 10 },
      },
      required: ["destination"],
    },
  },
  {
    name: "get_customer_context",
    description:
      "Retrieve the customer's profile, past bookings, preferences, and memory entries relevant to the current conversation.",
    input_schema: {
      type: "object",
      properties: {
        // TODO(prompt-13): Replace with real CRM schema
        include_bookings: { type: "boolean", description: "Include past booking history" },
        include_preferences: { type: "boolean", description: "Include stored preferences" },
        include_memory: { type: "boolean", description: "Include extracted memory facts" },
      },
      required: [],
    },
  },
  {
    name: "generate_quote",
    description:
      "Generate a pricing quote for a specific cruise sailing for the customer, including cabin category options.",
    input_schema: {
      type: "object",
      properties: {
        // TODO(prompt-13): Replace with real quote schema
        sailing_id: { type: "string", description: "Inventory sailing identifier" },
        cabin_category: {
          type: "string",
          enum: ["inside", "oceanview", "balcony", "suite"],
          description: "Cabin category requested",
        },
        num_guests: { type: "integer", description: "Number of guests" },
        include_insurance: {
          type: "boolean",
          description: "Include travel insurance in quote",
          default: false,
        },
      },
      required: ["sailing_id", "cabin_category", "num_guests"],
    },
  },
  {
    name: "collect_booking_details",
    description:
      "Collect and validate the information required to initiate a booking: guest details, payment preferences, special requests.",
    input_schema: {
      type: "object",
      properties: {
        // TODO(prompt-13): Replace with real booking details schema
        quote_id: { type: "string", description: "Quote identifier to book against" },
        primary_guest: {
          type: "object",
          description: "Primary guest details",
          properties: {
            first_name: { type: "string" },
            last_name: { type: "string" },
            date_of_birth: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
          },
        },
        special_requests: { type: "string", description: "Dietary, accessibility, or other notes" },
      },
      required: ["quote_id", "primary_guest"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Escalate the conversation to a human travel coordinator. Use when the customer requests human assistance, when an emergency is detected, or when the AI cannot resolve the issue.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "customer_requested",
            "emergency",
            "complaint_unresolved",
            "complex_booking",
            "regulatory_requirement",
            "other",
          ],
          description: "Reason for escalation",
        },
        summary: {
          type: "string",
          description: "Brief summary of the conversation context for the human coordinator",
        },
        urgency: {
          type: "string",
          enum: ["normal", "high", "emergency"],
          description: "Escalation urgency level",
          default: "normal",
        },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "update_memory",
    description:
      "Store a customer preference, fact, or important detail to the customer memory system for use in future conversations.",
    input_schema: {
      type: "object",
      properties: {
        // TODO(prompt-12): Replace with real customer memory schema
        memory_type: {
          type: "string",
          enum: ["preference", "fact", "constraint", "interest"],
          description: "Type of memory to store",
        },
        content: { type: "string", description: "The memory content to store" },
        confidence: {
          type: "number",
          description: "Confidence score 0–1 that this is an accurate reflection of the customer",
          minimum: 0,
          maximum: 1,
        },
      },
      required: ["memory_type", "content"],
    },
  },
  {
    name: "email_customer",
    description:
      "Email the SIGNED-IN customer the information they asked to receive (e.g. deck-plan links, an itinerary, a quote summary). Use ONLY when the customer explicitly asks you to email or send them something. You do NOT choose the recipient — the email always goes to the signed-in customer's own account address. If the customer is not signed in, this returns an error telling you to ask them to sign in first. Do not include any recipient address in your input.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "A concise, specific subject line, e.g. 'Norwegian Bliss deck plans'.",
        },
        body_markdown: {
          type: "string",
          description:
            "The email body as plain text. Include the links or details the customer asked for, one item per line. Do NOT include the recipient address or a greeting with their email.",
        },
      },
      required: ["subject", "body_markdown"],
    },
  },
];
