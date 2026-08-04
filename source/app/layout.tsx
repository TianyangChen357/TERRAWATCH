import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TERRAWATCH · Earth Observation Console",
  description:
    "An animated, bilingual console for exploring global satellite imagery, clouds, precipitation, land-surface temperature, simulated wind, and live Earth events.",
  icons: {
    icon: "/terrawatch/favicon.svg",
    shortcut: "/terrawatch/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Script src="/terrawatch-config.js" strategy="beforeInteractive" />
        {children}
      </body>
    </html>
  );
}
