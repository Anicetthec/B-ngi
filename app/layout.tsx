import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bĩngi — Stock & ventes",
  description: "Gérez votre boutique, votre stock et vos ventes, même hors ligne.",
  applicationName: "Bĩngi",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#153d32",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
