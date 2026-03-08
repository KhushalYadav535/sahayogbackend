"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.requireRole = requireRole;
exports.requireTenant = requireTenant;
exports.requirePermission = requirePermission;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = __importDefault(require("../../db/prisma"));
const audit_1 = require("../../db/audit");
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "No token provided" });
        return;
    }
    const token = authHeader.split(" ")[1];
    try {
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || "fallback_secret");
        req.user = payload;
        next();
    }
    catch {
        res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
}
function requireRole(...roles) {
    return (req, res, next) => {
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
function requireTenant(req, res, next) {
    if (!req.user?.tenantId) {
        res
            .status(403)
            .json({ success: false, message: "Tenant context required" });
        return;
    }
    next();
}
// SEC-001: Permission-based access control
function requirePermission(...permissions) {
    return async (req, res, next) => {
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
            const matrix = await prisma_1.default.permissionMatrix.findUnique({
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
            (0, audit_1.createAuditLog)({
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
//# sourceMappingURL=auth.js.map