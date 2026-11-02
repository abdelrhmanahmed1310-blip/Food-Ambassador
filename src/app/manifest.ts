import type { MetadataRoute } from "next";

/**
 * Installable app (ADR-057, ADR-060): "Add to home screen" on tablets and
 * phones, "Install" in desktop browsers. One app for every role; cashiers
 * open their register's till from it.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Food Ambassador",
    short_name: "Food Amb.",
    description: "Food operations and point of sale",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f6f7f5",
    theme_color: "#a3151b",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
