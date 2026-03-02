/**
 * Idempotency-Key middleware for financial writes
 * Prevents duplicate processing when client retries.
 * Uses Redis or in-memory store for key deduplication.
 */
import { Request, Response, NextFunction } from "express";

const IDEMPOTENCY_HEADER = "idempotency-key";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory store (use Redis in production)
const seenKeys = new Map<string, { response?: any; timestamp: number }>();

function cleanup() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of seenKeys) {
    if (v.timestamp < cutoff) seenKeys.delete(k);
  }
}
setInterval(cleanup, 60000);

export function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const key = req.headers[IDEMPOTENCY_HEADER] as string;
  if (!key) {
    next();
    return;
  }

  const existing = seenKeys.get(key);
  if (existing?.response) {
    res.status(existing.response.status).json(existing.response.body);
    return;
  }

  seenKeys.set(key, { timestamp: Date.now() });

  const originalJson = res.json.bind(res);
  res.json = function (body: any) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const entry = seenKeys.get(key);
      if (entry) entry.response = { status: res.statusCode, body };
    }
    return originalJson(body);
  };
  next();
}
