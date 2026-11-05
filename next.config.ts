import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Cache Components is intentionally disabled: almost every page is per-tenant
// and per-user, and a mis-scoped shared cache entry would be a cross-tenant
// data leak. See DECISIONS.md (ADR-004) before enabling it.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The camera is for barcode scanning on this site only (ADR-104).
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
  // Content-Security-Policy is set per request in src/proxy.ts: it carries a
  // fresh script nonce (ADR-074).
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

// Low-memory builds (ADR-076): hosts with a hard build memory cap (Render's
// is 8 GB) set LOW_MEMORY_BUILD=1. The build then skips its own TypeScript
// pass — CI and `pnpm check` typecheck every commit before it is pushed —
// uses at most two workers, and writes no server source maps.
const lowMemoryBuild = process.env.LOW_MEMORY_BUILD === "1";

const nextConfig: NextConfig = {
  ...(lowMemoryBuild ? { typescript: { ignoreBuildErrors: true } } : {}),
  // Self-contained server bundle for the Docker image (set in Dockerfile).
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
  // PDF and Excel export (ADR-089) read their own data files at run time.
  serverExternalPackages: ["pdfkit", "exceljs"],
  // The PDF fonts travel with the standalone server.
  outputFileTracingIncludes: { "/o/**": ["./assets/fonts/*.ttf"] },
  experimental: {
    // Attachments up to 3 MB (ADR-051, Q-08) plus multipart overhead. Other
    // uploads keep their own, lower limits in their actions.
    serverActions: { bodySizeLimit: "4mb" },
    ...(lowMemoryBuild ? { cpus: 2, serverSourceMaps: false } : {}),
  },
  ...(lowMemoryBuild ? { enablePrerenderSourceMaps: false } : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The service worker must always be fetched fresh so fixes reach every till (ADR-060).
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
