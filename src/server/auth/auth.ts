import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { uuidv7 } from "@/lib/uuid";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/modules/shared/schemas";
import { getDb } from "@/server/db/client";
import { getEnv } from "@/server/env";
import { consumeRateLimit } from "@/server/rate-limit";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Rate-limit rules shared by the auth HTTP endpoints and the auth server actions. */
export const AUTH_RATE_LIMITS = {
  signIn: { window: 60, max: 5 },
  signUp: { window: 60 * 60, max: 10 },
} as const;

function createAuth() {
  const env = getEnv();
  return betterAuth({
    appName: "Food Ambassador",
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: prismaAdapter(getDb(), { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      autoSignIn: true,
      // No email provider is configured yet (see DECISIONS.md Q-10).
      requireEmailVerification: false,
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": AUTH_RATE_LIMITS.signIn,
        "/sign-up/email": AUTH_RATE_LIMITS.signUp,
      },
      customStorage: { consume: (key, rule) => consumeRateLimit(`auth:${key}`, rule) },
    },
    advanced: {
      database: { generateId: () => uuidv7() },
      // Set by proxy.ts from trusted X-Forwarded-For hops; clients cannot spoof it.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: env.APP_URL.startsWith("https://"),
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
const globalForAuth = globalThis as unknown as { auth?: Auth };

/** Lazily constructed so `next build` does not require runtime secrets. */
export function getAuth(): Auth {
  if (!globalForAuth.auth) globalForAuth.auth = createAuth();
  return globalForAuth.auth;
}
