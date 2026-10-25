import { clock } from "../clock.js";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter using a single atomic UPSERT ... RETURNING, so
 * concurrent requests cannot both read a stale count. Buckets contain only
 * keyed hashes (never raw IPs, emails or license keys).
 */
export async function hitRateLimit(db: D1Database, bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const nowSec = Math.floor(clock.nowMs() / 1000);
  const windowStart = nowSec - (nowSec % windowSeconds);
  const row = await db
    .prepare(
      `INSERT INTO api_rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count, retryAfterSeconds: windowStart + windowSeconds - nowSec };
}

export async function purgeRateLimits(db: D1Database, olderThanSec: number) {
  await db.prepare("DELETE FROM api_rate_limits WHERE window_start < ?").bind(olderThanSec).run();
}
