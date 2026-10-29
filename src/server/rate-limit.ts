import "server-only";
import { getDb } from "@/server/db/client";

export interface RateLimitRule {
  /** Window length in seconds. */
  window: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number | null;
}

/**
 * Atomic fixed-window rate limiter backed by PostgreSQL, shared by every app
 * instance. The single upsert both checks and increments, so concurrent
 * requests cannot all slip through on a stale read.
 */
export async function consumeRateLimit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const rows = await getDb().$queryRaw<Array<{ count: number; window_start: Date }>>`
    INSERT INTO "rate_limit_buckets" ("key", "count", "window_start")
    VALUES (${key}, 1, now())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "rate_limit_buckets"."window_start" <= now() - make_interval(secs => ${rule.window}) THEN 1
        ELSE "rate_limit_buckets"."count" + 1 END,
      "window_start" = CASE
        WHEN "rate_limit_buckets"."window_start" <= now() - make_interval(secs => ${rule.window}) THEN now()
        ELSE "rate_limit_buckets"."window_start" END
    RETURNING "count", "window_start"`;
  const { count, window_start } = rows[0];
  if (count <= rule.max) return { allowed: true, retryAfter: null };
  const elapsed = (Date.now() - window_start.getTime()) / 1000;
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(rule.window - elapsed)) };
}
