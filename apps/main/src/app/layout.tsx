import type { Metadata } from "next";
import "./globals.css";
import { CookieConsentBanner } from "@/components/privacy/CookieConsentBanner";
import { PaymentRequiredBanner } from "@/components/billing/PaymentRequiredBanner";

export const metadata: Metadata = {
  title: "AI Travel Concierge",
  description: "AI-powered travel concierge platform",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <PaymentRequiredBanner />
        {children}
        <CookieConsentBanner />
      </body>
    </html>
  );
}
