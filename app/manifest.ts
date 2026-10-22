import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bingii — Gestion d'entreprise",
    short_name: "Bingii",
    description: "Gestion d'entreprise, de stock et de ventes hors ligne",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7f4",
    theme_color: "#263548",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
