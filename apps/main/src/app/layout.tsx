import type { Metadata } from "next";
import "./globals.css";
import { CookieConsentBanner } from "@/components/privacy/CookieConsentBanner";

export const metadata: Metadata = {
  title: "AI Travel Concierge",
  description: "AI-powered travel concierge platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <CookieConsentBanner />
      </body>
    </html>
  );
}
