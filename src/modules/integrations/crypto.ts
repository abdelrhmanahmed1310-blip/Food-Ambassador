import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Connector secrets and webhook signatures (DECISIONS.md ADR-048). Pure
 * except for randomness; the key is passed in.
 */

/** 32-byte key: the configured one, else derived from AUTH_SECRET with a purpose label. */
export function integrationKey(configured: string | undefined, authSecret: string): Buffer {
  if (configured) return Buffer.from(configured, "base64");
  return Buffer.from(
    hkdfSync("sha256", authSecret, "food-ambassador", "integrations:secrets:v1", 32),
  );
}

/** AES-256-GCM; output "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(".");
}

export function decryptSecret(sealed: string, key: Buffer): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** A new random secret for a connector, shown to the user once. */
export function newSecret(): string {
  return `fa_whsec_${randomBytes(32).toString("base64url")}`;
}

/** Signature header value over "<timestamp>.<body>". */
export function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Check a signed request: the signature must match (constant time) and the
 * timestamp (unix seconds) be within `toleranceSeconds` of now, so a
 * captured request cannot be replayed later.
 */
export function verifySignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): "OK" | "MISSING" | "STALE" | "MISMATCH" {
  if (!input.timestamp || !input.signature) return "MISSING";
  const ts = Number(input.timestamp);
  if (
    !/^\d{9,11}$/.test(input.timestamp) ||
    Math.abs(input.nowSeconds - ts) > (input.toleranceSeconds ?? 300)
  )
    return "STALE";
  const expected = Buffer.from(sign(input.secret, input.timestamp, input.body));
  const given = Buffer.from(input.signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? "OK" : "MISMATCH";
}

/** Delay before retry number `attempt` (1-based): 1 min, 5 min, 30 min, 2 h, 12 h; null = give up. */
export function retryDelaySeconds(attempt: number): number | null {
  const schedule = [60, 300, 1800, 7200, 43200];
  return attempt <= schedule.length ? schedule[attempt - 1] : null;
}

/**
 * Whether an outbound URL may be called: https only, and never to loopback,
 * private, link-local or metadata addresses (SSRF), unless explicitly
 * allowed for tests and local development.
 */
export function urlProblem(
  raw: string,
  resolvedAddresses: readonly string[],
  allowPrivate: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalidUrl";
  }
  if (url.username || url.password) return "credentialsInUrl";
  if (allowPrivate)
    return url.protocol === "https:" || url.protocol === "http:" ? null : "httpsRequired";
  if (url.protocol !== "https:") return "httpsRequired";
  if (resolvedAddresses.length === 0) return "unresolvable";
  return resolvedAddresses.some(isPrivateAddress) ? "privateAddress" : null;
}

export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase();
  if (a.includes(":")) {
    if (a === "::1" || a === "::") return true;
    if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
  );
}
