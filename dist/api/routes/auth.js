"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const audit_1 = require("../../db/audit");
const router = (0, express_1.Router)();
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
});
// POST /api/v1/auth/login
router.post("/login", async (req, res) => {
    try {
        const body = req.body || {};
        const { email, password } = loginSchema.parse(body);
        const user = await prisma_1.default.user.findUnique({ where: { email } });
        if (!user) {
            res.status(401).json({ success: false, message: "Invalid credentials" });
            return;
        }
        const valid = await bcrypt_1.default.compare(password, user.passwordHash);
        if (!valid) {
            res.status(401).json({ success: false, message: "Invalid credentials" });
            return;
        }
        if (user.status !== "active") {
            res.status(403).json({ success: false, message: "Account is not active" });
            return;
        }
        const token = jsonwebtoken_1.default.sign({
            userId: user.id,
            tenantId: user.tenantId,
            role: user.role,
            email: user.email,
        }, process.env.JWT_SECRET || "fallback_secret", { expiresIn: "8h" });
        (0, audit_1.createAuditLog)({
            tenantId: user.tenantId ?? undefined,
            userId: user.id,
            action: "LOGIN",
            entity: "User",
            entityId: user.id,
            ipAddress: req.ip,
        }).catch((e) => console.error("[Auth] Audit log failed:", e));
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                tenantId: user.tenantId,
            },
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Auth] Login error:", err);
        const msg = err instanceof Error ? err.message : "Server error";
        res.status(500).json({ success: false, message: process.env.NODE_ENV === "development" ? msg : "Server error" });
    }
});
// POST /api/v1/auth/register (superadmin or admin creating users)
router.post("/register", async (req, res) => {
    try {
        const schema = zod_1.z.object({
            email: zod_1.z.string().email(),
            password: zod_1.z.string().min(8),
            name: zod_1.z.string().min(2),
            role: zod_1.z.enum(["superadmin", "admin", "staff"]).default("staff"),
            tenantId: zod_1.z.string().optional(),
        });
        const data = schema.parse(req.body);
        const passwordHash = await bcrypt_1.default.hash(data.password, 12);
        const user = await prisma_1.default.user.create({
            data: {
                email: data.email,
                passwordHash,
                name: data.name,
                role: data.role,
                tenantId: data.tenantId,
            },
        });
        res.status(201).json({
            success: true,
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/auth/impersonate — super admin impersonates tenant admin
router.post("/impersonate", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "No token provided" });
        return;
    }
    try {
        const callerPayload = jsonwebtoken_1.default.verify(authHeader.split(" ")[1], process.env.JWT_SECRET || "fallback_secret");
        if (callerPayload.role !== "superadmin") {
            res.status(403).json({ success: false, message: "Only super admin can impersonate" });
            return;
        }
        const { tenantId } = zod_1.z.object({ tenantId: zod_1.z.string() }).parse(req.body);
        const tenant = await prisma_1.default.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Tenant not found" });
            return;
        }
        const adminUser = await prisma_1.default.user.findFirst({
            where: { tenantId, role: "admin", status: "active" },
        });
        if (!adminUser) {
            res.status(404).json({ success: false, message: "No active admin user found for this tenant" });
            return;
        }
        const token = jsonwebtoken_1.default.sign({
            userId: adminUser.id,
            tenantId: adminUser.tenantId,
            role: adminUser.role,
            email: adminUser.email,
            impersonatedBy: callerPayload.userId,
        }, process.env.JWT_SECRET || "fallback_secret", { expiresIn: "2h" });
        res.json({
            success: true,
            token,
            user: { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: adminUser.role, tenantId: adminUser.tenantId },
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/auth/me
router.get("/me", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
    }
    try {
        const token = authHeader.split(" ")[1];
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || "fallback_secret");
        const user = await prisma_1.default.user.findUnique({
            where: { id: payload.userId },
            select: { id: true, email: true, name: true, role: true, tenantId: true, status: true },
        });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        res.json({ success: true, user });
    }
    catch {
        res.status(401).json({ success: false, message: "Invalid token" });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map