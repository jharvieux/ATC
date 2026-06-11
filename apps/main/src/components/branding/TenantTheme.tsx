// §16.2 — Runtime tenant theme injector. Rendered by tenant-facing
// server pages/layouts; emits the tenant's colors as CSS custom
// properties plus the Google Fonts stylesheet for a non-system font.
// No-op on the platform domain and for tenants with no theme fields set,
// so it's safe to drop into any dynamic server tree.
//
// Deliberately NOT in the root layout: reading request headers there
// would force the whole app dynamic, breaking the ISR/static routes
// (/agents/[slug], /chat/[slug]).

import * as React from "react";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { buildTenantThemeCss, googleFontHrefFor } from "@/lib/branding/tenant-theme";

export async function TenantTheme(): Promise<React.ReactElement | null> {
  const branding = await getRequestTenantBranding();
  if (!branding) return null;

  const css = buildTenantThemeCss(branding);
  const fontHref = googleFontHrefFor(branding.font_family);
  if (!css && !fontHref) return null;

  return (
    <>
      {fontHref ? <link rel="stylesheet" href={fontHref} /> : null}
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
    </>
  );
}
