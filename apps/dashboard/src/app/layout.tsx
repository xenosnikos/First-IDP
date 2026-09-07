import type { Metadata } from "next";
import { Gloock, Azeret_Mono } from "next/font/google";
import "./globals.css";

// Nebula brand type (docs/NEBULA.md §2): Gloock for display, Azeret Mono for
// everything else. No sans-serif anywhere.
const gloock = Gloock({ weight: "400", subsets: ["latin"], variable: "--font-gloock", display: "swap" });
const azeret = Azeret_Mono({ subsets: ["latin"], variable: "--font-azeret", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Nebula", template: "%s · Nebula" },
  description: "Nebula — Twizz preview environments. DB-isolated named envs from existing release images, human-gated.",
};

// Applied before paint so a pinned theme never flashes. Dark is the default
// ("catalogue plate"); the light "paper print" follows the OS unless pinned.
const themeBoot = `(function(){try{var t=localStorage.getItem("nebula-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${gloock.variable} ${azeret.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
