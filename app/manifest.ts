import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bingii — Gestion de Boutique",
    short_name: "Bingii",
    description: "Gestion de stock et de ventes hors ligne",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7f4",
    theme_color: "#263548",
    icons: [
      { src: "/bingii-logo.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
