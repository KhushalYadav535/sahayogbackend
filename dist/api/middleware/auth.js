"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.requireRole = requireRole;
exports.requireTenant = requireTenant;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
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
//# sourceMappingURL=auth.js.map