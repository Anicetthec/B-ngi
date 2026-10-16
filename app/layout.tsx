import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bĩngi — Gestion de Boutique",
  description: "Gérez votre boutique, votre stock et vos ventes avec Bĩngi.",
  applicationName: "Bĩngi",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/bingii-logo.svg",
    shortcut: "/bingii-logo.svg",
    apple: "/bingii-logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#263548",
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
