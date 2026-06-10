// #963 — Registry of tenant-overridable outgoing email types.
//
// Each entry documents the variables a tenant may reference in a subject or
// body override ({{variable}} syntax). Save-time validation (PUT
// /api/tenant/email-templates/[type]) rejects overrides referencing names
// not listed here; send-time rendering throws on any residual mismatch
// rather than sending an empty or half-rendered body.
//
// The key doubles as the email_log.template_id written by the sender, so
// log rows and overrides correlate 1:1.
//
// Client-safe: pure data, no server imports (the settings UI renders
// variable docs + previews from this registry).

export interface TemplateVariable {
  name: string;
  description: string;
  sample: string;
}

export interface EmailTemplateSpec {
  label: string;
  description: string;
  default_subject_template: string;
  variables: readonly TemplateVariable[];
  /**
   * #975 — present when the platform writes AI-generated content into this
   * email. A body override may place it with {{ai_content}}; omitting the
   * token sends the override without AI content (allowed, editor warns).
   * Never valid in subjects — the value is multi-paragraph text.
   */
  ai_content?: { description: string };
}

export const AI_CONTENT_VARIABLE = "ai_content";

/** Variable names allowed in a BODY template (subjects use spec.variables only). */
export function bodyVariableNames(spec: EmailTemplateSpec): string[] {
  const names = spec.variables.map((v) => v.name);
  return spec.ai_content ? [...names, AI_CONTENT_VARIABLE] : names;
}

const PRE_CRUISE_VARIABLES: readonly TemplateVariable[] = [
  { name: "customer_name", description: "Lead passenger's name", sample: "Alice Rivera" },
  { name: "ship_name", description: "Ship name", sample: "Wonder of the Seas" },
  { name: "cruise_line", description: "Cruise line", sample: "Royal Caribbean" },
  { name: "sailing_date", description: "Sailing date", sample: "2026-09-12" },
  { name: "companion_page_url", description: "Link to the customer's cruise companion page", sample: "https://example.ai-travelconcierge.com/companion/abc123" },
];

const GROUP_VARIABLES: readonly TemplateVariable[] = [
  { name: "invitee_name", description: "Invitee's name (falls back to \"there\")", sample: "Sam" },
  { name: "cruise_line", description: "Cruise line", sample: "Carnival" },
  { name: "ship_name", description: "Ship name", sample: "Mardi Gras" },
  { name: "sailing_date", description: "Sailing date", sample: "2026-11-03" },
  { name: "coordinator_message", description: "The coordinator's personal message (may be empty)", sample: "Can't wait to sail with you all!" },
];

const GROUP_INVITATION_VARIABLES: readonly TemplateVariable[] = [
  ...GROUP_VARIABLES,
  { name: "departure_port", description: "Port of departure", sample: "Miami, FL" },
  { name: "invite_url", description: "The invitee's personal RSVP link", sample: "https://example.ai-travelconcierge.com/groups/invite/tok123" },
];

export const EMAIL_TEMPLATE_REGISTRY = {
  pre_cruise_t_90: {
    label: "Pre-cruise — 90 days out",
    description:
      "Sent 90 days before sailing. Place {{ai_content}} in a custom body to position the AI-generated sections around your own copy; leave it out to send your copy alone.",
    default_subject_template: "90 days to your {{cruise_line}} cruise — let the anticipation begin!",
    variables: PRE_CRUISE_VARIABLES,
    ai_content: {
      description:
        "AI writes personalized destination highlights, must-do experiences, and a documentation reminder for this sailing here.",
    },
  },
  pre_cruise_t_30: {
    label: "Pre-cruise — 30 days out",
    description:
      "Sent 30 days before sailing. Place {{ai_content}} in a custom body to position the AI-generated sections around your own copy; leave it out to send your copy alone.",
    default_subject_template: "30 days out — final prep for {{ship_name}}",
    variables: PRE_CRUISE_VARIABLES,
    ai_content: {
      description:
        "AI writes personalized reservation reminders, online check-in guidance, and packing inspiration for this sailing here.",
    },
  },
  pre_cruise_t_7: {
    label: "Pre-cruise — 7 days out",
    description:
      "Sent 7 days before sailing. Place {{ai_content}} in a custom body to position the AI-generated sections around your own copy; leave it out to send your copy alone.",
    default_subject_template: "One week away — pack, prepare, and get excited!",
    variables: PRE_CRUISE_VARIABLES,
    ai_content: {
      description:
        "AI writes a personalized packing checklist, ship highlights, cruise-line tips, and embarkation advice for this sailing here.",
    },
  },
  pre_cruise_t_1: {
    label: "Pre-cruise — 1 day out",
    description:
      "Sent the day before sailing. Place {{ai_content}} in a custom body to position the AI-generated sections around your own copy; leave it out to send your copy alone.",
    default_subject_template: "Tomorrow! Your {{cruise_line}} cruise departs — final checklist inside",
    variables: PRE_CRUISE_VARIABLES,
    ai_content: {
      description:
        "AI writes a preview of your first port of call and what to expect on departure day here.",
    },
  },
  group_invitation: {
    label: "Group invitation",
    description: "Sent when a coordinator invites someone to a group cruise.",
    default_subject_template: "You're invited to a group cruise!",
    variables: GROUP_INVITATION_VARIABLES,
  },
  group_reminder: {
    label: "Group invitation reminder",
    description: "Periodic reminder to invitees who haven't RSVP'd yet.",
    default_subject_template: "Reminder: {{cruise_line}} — {{ship_name}} sailing {{sailing_date}}",
    variables: GROUP_VARIABLES,
  },
  quote_estimate_expired: {
    label: "Quote estimate expired",
    description: "Sent when a customer's price estimate passes its validity window.",
    default_subject_template: "Your estimate for {{cruise_label}} has expired — request fresh pricing",
    variables: [
      { name: "customer_name", description: "Customer's name", sample: "Alice Rivera" },
      { name: "cruise_label", description: "Cruise description (falls back to \"your cruise\")", sample: "Mardi Gras sailing 2026-11-03" },
      { name: "refresh_url", description: "Link to request fresh pricing", sample: "https://example.ai-travelconcierge.com/quotes/q1/refresh" },
      { name: "validity_days", description: "How many days estimates stay valid", sample: "14" },
    ],
  },
  task_reminder: {
    label: "Task reminder",
    description: "Sent to the task assignee (or creator) when a task reminder fires.",
    default_subject_template: "Task reminder: {{task_title}}",
    variables: [
      { name: "recipient_name", description: "Name of the task recipient", sample: "Alex Chen" },
      { name: "task_title", description: "Title of the task", sample: "Follow up with cruise quote" },
      { name: "task_description", description: "Task description (may be empty)", sample: "Client asked for Royal Caribbean options" },
      { name: "due_at", description: "Task due date/time (may be empty)", sample: "2026-07-01T14:00:00Z" },
      { name: "priority", description: "Task priority (low, normal, high)", sample: "high" },
      { name: "task_url", description: "Link to the task in the CRM", sample: "https://example.ai-travelconcierge.com/crm/tasks/abc123" },
    ],
  },
} as const satisfies Record<string, EmailTemplateSpec>;

export type EmailTemplateType = keyof typeof EMAIL_TEMPLATE_REGISTRY;

export const EMAIL_TEMPLATE_TYPES = Object.keys(EMAIL_TEMPLATE_REGISTRY) as EmailTemplateType[];

export function isEmailTemplateType(value: string): value is EmailTemplateType {
  return value in EMAIL_TEMPLATE_REGISTRY;
}
