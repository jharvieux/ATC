import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Travel Concierge",
  description: "Expert travel advisors powered by AI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
