import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Bĩngi — Stock & ventes",
    short_name: "Bĩngi",
    description: "Gestion de stock et de ventes hors ligne",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f7f4",
    theme_color: "#153d32",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
