import type { Metadata, Viewport } from "next";
import { Baloo_2, Nunito } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/shell/AppShell";

/** UI face: Nunito variable, 400–700. Its digits are tabular by default, so every figure stays put. */
const nunito = Nunito({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-nunito",
});

/**
 * Display face: Baloo 2 variable, for headings, scores and the wordmark. Of the
 * rounded display families it is the one that ships true tabular figures (a
 * `tnum` feature; Fredoka and Lilita One have proportional digits only), which
 * the display type utilities in globals.css rely on for rolling scores.
 */
const baloo = Baloo_2({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-baloo",
});

export const metadata: Metadata = {
  title: {
    default: "Sideout",
    template: "%s · Sideout",
  },
  description: "Charity beach volleyball tournaments: live play, standings, and what every event raises.",
  applicationName: "Sideout",
  icons: { icon: "/icon.svg", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "Sideout", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#fbf2df",
  colorScheme: "light",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${nunito.variable} ${baloo.variable} h-full`}>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
