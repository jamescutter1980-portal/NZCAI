import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NZC AI — Land",
  description: "Grid capacity screening for solar PV siting",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-GB">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
