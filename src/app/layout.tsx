import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = {
  title: "NZC Portal",
  description: "Net zero carbon and ESG data portal",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#f7f7f5", color: "#1a1a1a" }}>
        <header style={{ padding: "12px 24px", borderBottom: "1px solid #ddd", background: "#fff" }}>
          <Link href="/" style={{ fontWeight: 600, textDecoration: "none", color: "inherit" }}>
            NZC Portal
          </Link>
        </header>
        <main style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px" }}>{children}</main>
      </body>
    </html>
  );
}
