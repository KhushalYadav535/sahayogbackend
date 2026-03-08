/**
 * RSK-004: IP-Based Access Restrictions Middleware
 */
import { Request, Response, NextFunction } from "express";
import prisma from "../../db/prisma";

export async function ipRestrictionsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) {
      // Skip IP check if no tenant context (public routes)
      return next();
    }

    // Get IP allowlist from config
    const config = await prisma.systemConfig.findUnique({
      where: { tenantId_key: { tenantId, key: "ip.allowlist" } },
    });

    if (!config?.value) {
      // No IP restrictions configured, allow all
      return next();
    }

    const allowedIPs: string[] = JSON.parse(config.value);
    const clientIP = req.ip || req.socket.remoteAddress || "";

    // Check if IP is in allowlist
    if (allowedIPs.length > 0 && !allowedIPs.includes(clientIP)) {
      res.status(403).json({
        success: false,
        message: "Access denied: IP address not in allowlist",
      });
      return;
    }

    next();
  } catch (err) {
    console.error("[IP Restrictions]", err);
    // On error, allow access (fail open for availability)
    next();
  }
}
