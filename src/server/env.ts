import "server-only";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "DATABASE_URL must be a PostgreSQL URL"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
  APP_URL: z.url().default("http://localhost:3000"),
  // Signs and encrypts session data. Generate with `openssl rand -base64 48`.
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  // Read by proxy.ts (see src/lib/client-ip.ts); validated here so misconfiguration fails fast.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  // Encrypts connector secrets (32 bytes, base64). Optional: derived from AUTH_SECRET when unset (ADR-048).
  INTEGRATION_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine(
      (v) => !v || Buffer.from(v, "base64").length === 32,
      "INTEGRATION_ENCRYPTION_KEY must be 32 bytes, base64",
    ),
  // Allow outbound webhooks to http:// and private addresses (tests and local development only).
  INTEGRATIONS_ALLOW_PRIVATE_URLS: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
  // ClamAV daemon for attachment scanning, e.g. tcp://clamav:3310 (ADR-055). Unset = not scanned.
  CLAMAV_URL: z
    .string()
    .optional()
    .refine(
      (v) => !v || /^tcp:\/\/[^:/\s]+:\d{1,5}$/.test(v),
      "CLAMAV_URL must be tcp://host:port",
    ),
  // USDA FoodData Central API key from api.data.gov (ADR-132). Unset = live USDA search is off;
  // the local library keeps working. Server-side only, never sent to browsers.
  USDA_FDC_API_KEY: z.string().optional(),
  USDA_FDC_BASE_URL: z.url().default("https://api.nal.usda.gov/fdc/v1"),
  // Calls per hour across all instances; USDA's default limit per key is 1,000.
  USDA_FDC_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).max(100000).default(1000),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Validated server environment. Parsed lazily so `next build` does not need
 * runtime secrets; the first request (or test) that needs a value fails fast
 * with a readable message if configuration is wrong. Values are never logged.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  cached = result.data;
  return cached;
}

/** Test hook: forget the cached environment so a test can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
