export const CLIENT_IP_HEADER = "x-client-ip";

/**
 * Client IP from X-Forwarded-For: the entry appended by the outermost of
 * `trustedHops` proxies. Entries before it are client-controlled and ignored.
 */
export function clientIpFrom(forwardedFor: string | null, trustedHops: number): string {
  if (trustedHops === 0 || !forwardedFor) return "unknown";
  const hops = forwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[hops.length - trustedHops] ?? "unknown";
}

export function trustedHopsFromEnv(value: string | undefined): number {
  const n = Number(value ?? "1");
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}
