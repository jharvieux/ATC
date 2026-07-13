// §20.7 — Sub-host tenant-of-record disclosure.
//
// Renders: "This booking will be made through [Host Agency Name].
//           Your sub-host: [Tenant Name]. Customer service contact: [Email]."
//
// Embed on: booking Review stage, booking confirmation page,
// booking confirmation email, quote acceptance page.

interface TenantOfRecordDisclosureProps {
  tenant: {
    name: string;
    support_email: string;
  };
  hostAgency: {
    legal_name: string;
  };
}

export function TenantOfRecordDisclosure({
  tenant,
  hostAgency,
}: TenantOfRecordDisclosureProps) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p>
        This booking will be made through{" "}
        <strong>{hostAgency.legal_name}</strong>. Your sub-host:{" "}
        <strong>{tenant.name}</strong>.
        {tenant.support_email && (
          <>
            {" "}Customer service contact:{" "}
            <a href={`mailto:${tenant.support_email}`} className="underline">
              {tenant.support_email}
            </a>
            .
          </>
        )}
      </p>
    </div>
  );
}
