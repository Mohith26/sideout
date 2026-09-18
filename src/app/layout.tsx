import type { Metadata, Viewport } from "next";
import { Archivo, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";

/** UI face: Instrument Sans variable, 400–600. */
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-sans",
});

/**
 * Display face. "Archivo Expanded" is not a separate Google Fonts family; it is
 * the Archivo variable font with its width axis at the expanded stop. Loading
 * the `wdth` axis here and setting `font-stretch: 125%` in the display type
 * utilities (globals.css) produces the expanded cut without a second download.
 */
const archivo = Archivo({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-archivo",
  axes: ["wdth"],
});

export const metadata: Metadata = {
  title: {
    default: "Sideout",
    template: "%s · Sideout",
  },
  description: "Charity beach volleyball tournaments: live play, standings, and what every event raises.",
  applicationName: "Sideout",
  icons: { icon: "/icon.svg", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Sideout", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#08090B",
  colorScheme: "dark",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${instrumentSans.variable} ${archivo.variable} h-full`}>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
