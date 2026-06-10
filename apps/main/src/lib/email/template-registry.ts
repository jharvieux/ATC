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

export const EMAIL_TEMPLATE_REGISTRY = {
  pre_cruise_t_90: {
    label: "Pre-cruise — 90 days out",
    description:
      "Sent 90 days before sailing. The platform default body includes AI-generated destination highlights; a custom body replaces that content entirely.",
    default_subject_template: "90 days to your {{cruise_line}} cruise — let the anticipation begin!",
    variables: PRE_CRUISE_VARIABLES,
  },
  pre_cruise_t_30: {
    label: "Pre-cruise — 30 days out",
    description:
      "Sent 30 days before sailing. The platform default body includes AI-generated reservation and packing guidance; a custom body replaces that content entirely.",
    default_subject_template: "30 days out — final prep for {{ship_name}}",
    variables: PRE_CRUISE_VARIABLES,
  },
  pre_cruise_t_7: {
    label: "Pre-cruise — 7 days out",
    description:
      "Sent 7 days before sailing. The platform default body includes an AI-generated packing checklist and the cruise weather forecast; a custom body replaces that content entirely.",
    default_subject_template: "One week away — pack, prepare, and get excited!",
    variables: PRE_CRUISE_VARIABLES,
  },
  pre_cruise_t_1: {
    label: "Pre-cruise — 1 day out",
    description:
      "Sent the day before sailing. The platform default body includes departure-port logistics and the carry-on essentials checklist; a custom body replaces that content entirely.",
    default_subject_template: "Tomorrow! Your {{cruise_line}} cruise departs — final checklist inside",
    variables: PRE_CRUISE_VARIABLES,
  },
  group_invitation: {
    label: "Group invitation",
    description: "Sent when a coordinator invites someone to a group cruise.",
    default_subject_template: "You're invited to a group cruise!",
    variables: [
      ...GROUP_VARIABLES,
      { name: "invite_url", description: "The invitee's personal RSVP link", sample: "https://example.ai-travelconcierge.com/groups/invite/tok123" },
    ],
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
} as const satisfies Record<string, EmailTemplateSpec>;

export type EmailTemplateType = keyof typeof EMAIL_TEMPLATE_REGISTRY;

export const EMAIL_TEMPLATE_TYPES = Object.keys(EMAIL_TEMPLATE_REGISTRY) as EmailTemplateType[];

export function isEmailTemplateType(value: string): value is EmailTemplateType {
  return value in EMAIL_TEMPLATE_REGISTRY;
}
