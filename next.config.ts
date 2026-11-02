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
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
  // Content-Security-Policy is set per request in src/proxy.ts: it carries a
  // fresh script nonce (ADR-074).
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (set in Dockerfile).
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  poweredByHeader: false,
  experimental: {
    // Attachments up to 3 MB (ADR-051, Q-08) plus multipart overhead. Other
    // uploads keep their own, lower limits in their actions.
    serverActions: { bodySizeLimit: "4mb" },
  },
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
