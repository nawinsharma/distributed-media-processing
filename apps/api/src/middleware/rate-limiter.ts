import type { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import type { Env } from "@repo/utils";

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createRateLimiter(config: Env) {
  const maxRequests = config.RATE_LIMIT_REQUESTS_PER_MINUTE;
  const windowMs = 60 * 1000;
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const ip = getClientIp(req);
      const key = `rate:${ip}`;
      const now = Date.now();

      const total = await redis.incr(key);
      if (total === 1) {
        await redis.pexpire(key, windowMs);
      }
      const ttlMs = Math.max(0, await redis.pttl(key));

      res.setHeader("X-RateLimit-Limit", maxRequests);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - total));
      res.setHeader("X-RateLimit-Reset", Math.ceil((now + ttlMs) / 1000));

      if (total > maxRequests) {
        res.status(429).json({
          error: "Too many requests",
          retryAfter: Math.ceil(ttlMs / 1000),
        });
        return;
      }

      next();
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Rate limiter error";
      res.status(503).json({ error: message });
    });
  };
}
