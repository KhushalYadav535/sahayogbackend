"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ipRestrictionsMiddleware = ipRestrictionsMiddleware;
const prisma_1 = __importDefault(require("../../db/prisma"));
async function ipRestrictionsMiddleware(req, res, next) {
    try {
        const tenantId = req.headers["x-tenant-id"];
        if (!tenantId) {
            // Skip IP check if no tenant context (public routes)
            return next();
        }
        // Get IP allowlist from config
        const config = await prisma_1.default.systemConfig.findUnique({
            where: { tenantId_key: { tenantId, key: "ip.allowlist" } },
        });
        if (!config?.value) {
            // No IP restrictions configured, allow all
            return next();
        }
        const allowedIPs = JSON.parse(config.value);
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
    }
    catch (err) {
        console.error("[IP Restrictions]", err);
        // On error, allow access (fail open for availability)
        next();
    }
}
//# sourceMappingURL=ip-restrictions.js.map