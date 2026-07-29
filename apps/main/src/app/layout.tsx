import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { CookieConsentBanner } from "@/components/privacy/CookieConsentBanner";
import { PaymentRequiredBanner } from "@/components/billing/PaymentRequiredBanner";
import { ThemeProvider } from "@/components/theme-provider";
import { siteOrigin } from "@/lib/seo/site";

// Site-wide metadata defaults. Individual pages override title/description;
// anything a page doesn't set is inherited from here.
//
// metadataBase is always the platform origin, never the request host, so
// relative OG/canonical URLs resolve to the one domain we let crawlers index
// (D-368). Tenant hosts are noindex via X-Robots-Tag in proxy.ts, so they
// never act on these values.
//
// Note for pages rendering tenant-owned names: set `title: { absolute: … }`.
// A bare string gets the "%s | AI Travel Concierge" template appended, which
// would stamp platform branding onto white-label Agency-tier surfaces.
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: {
    default: "AI Travel Concierge — AI software for independent cruise agents",
    template: "%s | AI Travel Concierge",
  },
  description:
    "The AI and software layer for independent cruise agents. Six AI cruise specialists quote, research, and follow up for you — with a built-in CRM, branded quotes, and automatic pre-cruise emails. Bring your own host agency and keep 100% of your commission. Free 30-day trial.",
  applicationName: "AI Travel Concierge",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "AI Travel Concierge",
    title: "AI Travel Concierge — AI software for independent cruise agents",
    description:
      "Your AI cruise crew quotes, researches, and follows up for you — so a single agent runs like a full agency. Bring your own host. Free 30-day trial.",
    url: "/",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Travel Concierge — AI software for independent cruise agents",
    description:
      "Your AI cruise crew quotes, researches, and follows up for you — so a single agent runs like a full agency. Bring your own host. Free 30-day trial.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <PaymentRequiredBanner />
          {children}
          <CookieConsentBanner />
        </ThemeProvider>
      </body>
    </html>
  );
}
