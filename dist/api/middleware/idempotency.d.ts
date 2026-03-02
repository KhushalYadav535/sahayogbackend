/**
 * Idempotency-Key middleware for financial writes
 * Prevents duplicate processing when client retries.
 * Uses Redis or in-memory store for key deduplication.
 */
import { Request, Response, NextFunction } from "express";
export declare function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=idempotency.d.ts.map