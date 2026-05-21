// Spec ref: §5.4.2
//
// A TenantContext carries a tenant_id PLUS a provenance — where the context
// was constructed and under whose authority. Provenance is required so
// audit can answer "who constructed a TenantContext for tenant X at time Y."
//
// TenantContexts are NOT constructible inline. They are produced only by
// the four factory functions in factories.ts, each of which validates
// authority-to-act and attaches the right `source` discriminant.

export type TenantContext = {
  tenant_id: string;
  source:
    | { kind: "http_request"; user_id: string }
    | { kind: "stripe_webhook"; stripe_event_id: string }
    | { kind: "inngest_job"; function_name: string; event_id: string }
    | { kind: "platform_admin"; admin_user_id: string; reason: string };
};
