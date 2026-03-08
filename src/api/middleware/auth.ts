import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../../db/prisma";
import { createAuditLog } from "../../db/audit";

export interface JwtPayload {
    userId: string;
    tenantId: string | null;
    role: string;
    email: string;
}

export type AuthRequest = Request & { user?: JwtPayload };

export function authMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction
): void {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "No token provided" });
        return;
    }

    const token = authHeader.split(" ")[1];

    try {
        const payload = jwt.verify(
            token,
            process.env.JWT_SECRET || "fallback_secret"
        ) as JwtPayload;

        req.user = payload;
        next();
    } catch {
        res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
}

export function requireRole(...roles: string[]) {
    return (req: AuthRequest, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res
                .status(403)
                .json({ success: false, message: "Insufficient permissions" });
            return;
        }
        next();
    };
}

export function requireTenant(
    req: AuthRequest,
    res: Response,
    next: NextFunction
): void {
    if (!req.user?.tenantId) {
        res
            .status(403)
            .json({ success: false, message: "Tenant context required" });
        return;
    }
    next();
}

// SEC-001: Permission-based access control
export function requirePermission(...permissions: string[]) {
    return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
        if (!req.user) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }

        const tenantId = req.user.tenantId;
        const role = req.user.role;

        // Platform admin bypasses permission checks
        if (role === "superadmin" || role === "platform_admin") {
            next();
            return;
        }

        // Get permission matrix for role
        if (tenantId) {
            const matrix = await prisma.permissionMatrix.findUnique({
                where: { tenantId_role: { tenantId, role } },
            });

            if (matrix && matrix.isActive) {
                const hasAllPermissions = permissions.every((perm) => matrix.permissions.includes(perm));
                if (hasAllPermissions) {
                    next();
                    return;
                }
            }
        }

        // Log unauthorized access attempt
        if (tenantId) {
            createAuditLog({
                tenantId,
                userId: req.user.userId,
                action: "UNAUTHORIZED_ACCESS",
                entity: "Permission",
                entityId: permissions.join(","),
                newData: { requestedPermissions: permissions, role },
            }).catch((e) => console.error("[Auth] Audit log failed:", e));
        }

        res.status(403).json({
            success: false,
            message: "Insufficient permissions",
            requiredPermissions: permissions,
        });
    };
}
