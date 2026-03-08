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
// Helper: Get config value
async function getConfig(tenantId, key, defaultValue) {
    if (!tenantId)
        return defaultValue;
    const config = await prisma_1.default.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key } },
    });
    return config?.value || defaultValue;
}
async function getConfigNumber(tenantId, key, defaultValue) {
    const value = await getConfig(tenantId, key, defaultValue.toString());
    return parseFloat(value) || defaultValue;
}
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    mfaCode: zod_1.z.string().optional(), // SEC-002: MFA code for TOTP
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
        // RSK-005: Check password expiry
        const expiryDays = await getConfigNumber(user.tenantId, "password.expiry.days", 90);
        const passwordChangedAt = user.passwordChangedAt || user.createdAt;
        const daysSinceChange = Math.floor((Date.now() - passwordChangedAt.getTime()) / (24 * 60 * 60 * 1000));
        const daysUntilExpiry = expiryDays - daysSinceChange;
        if (user.passwordForceExpire || daysUntilExpiry <= 0) {
            res.status(403).json({
                success: false,
                message: "Password expired. Please change your password.",
                requiresPasswordChange: true,
            });
            return;
        }
        // SEC-002: MFA Check (for staff roles)
        const staffRoles = ["superadmin", "admin", "staff", "secretary", "accountant", "loan_officer", "compliance_officer", "auditor"];
        if (staffRoles.includes(user.role) && user.mfaEnabled) {
            const { mfaCode } = req.body;
            if (!mfaCode) {
                res.status(401).json({
                    success: false,
                    message: "MFA code required",
                    requiresMfa: true,
                });
                return;
            }
            // Verify TOTP code
            const speakeasy = require("speakeasy");
            const verified = speakeasy.totp.verify({
                secret: user.totpSecret,
                encoding: "base32",
                token: mfaCode,
                window: 2,
            });
            if (!verified && !user.totpBackupCodes.includes(mfaCode)) {
                res.status(401).json({ success: false, message: "Invalid MFA code" });
                return;
            }
            // If backup code used, remove it
            if (user.totpBackupCodes.includes(mfaCode)) {
                const updatedCodes = user.totpBackupCodes.filter((c) => c !== mfaCode);
                await prisma_1.default.user.update({
                    where: { id: user.id },
                    data: { totpBackupCodes: updatedCodes },
                });
            }
        }
        // RSK-003: Concurrent session control
        const maxSessions = await getConfigNumber(user.tenantId, "session.max.concurrent", 1);
        const existingSessions = await prisma_1.default.session.findMany({
            where: { userId: user.id, expiresAt: { gt: new Date() } },
            orderBy: { lastActivityAt: "asc" },
        });
        // Kill oldest sessions if limit exceeded
        if (existingSessions.length >= maxSessions) {
            const sessionsToKill = existingSessions.slice(0, existingSessions.length - maxSessions + 1);
            await prisma_1.default.session.deleteMany({
                where: { id: { in: sessionsToKill.map((s) => s.id) } },
            });
        }
        const token = jsonwebtoken_1.default.sign({
            userId: user.id,
            tenantId: user.tenantId,
            role: user.role,
            email: user.email,
        }, process.env.JWT_SECRET || "fallback_secret", { expiresIn: "8h" });
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 8);
        // RSK-003: Create session record
        await prisma_1.default.session.create({
            data: {
                userId: user.id,
                tenantId: user.tenantId,
                token,
                ipAddress: req.ip,
                userAgent: req.headers["user-agent"] || undefined,
                expiresAt,
            },
        });
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
            passwordExpiry: {
                daysUntilExpiry,
                alertLevel: daysUntilExpiry <= 7 ? (daysUntilExpiry <= 1 ? "CRITICAL" : "WARNING") : "NONE",
            },
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
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
            role: zod_1.z.enum([
                "superadmin",
                "admin",
                "president",
                "secretary",
                "accountant",
                "senior_accountant",
                "loan_officer",
                "compliance_officer",
                "auditor",
                "member",
                "staff", // legacy alias for accountant
            ]).default("accountant"),
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
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/auth/register-tenant (Public Self-Serve Registration)
router.post("/register-tenant", async (req, res) => {
    try {
        const schema = zod_1.z.object({
            societyName: zod_1.z.string().min(2),
            adminName: zod_1.z.string().min(2),
            email: zod_1.z.string().email(),
            password: zod_1.z.string().min(8)
        });
        const data = schema.parse(req.body);
        // Check if user already exists
        const existingUser = await prisma_1.default.user.findUnique({ where: { email: data.email } });
        if (existingUser) {
            res.status(400).json({ success: false, message: "User with this email already exists" });
            return;
        }
        // Generate a 4-letter + 4-digit code
        const safeName = data.societyName.replace(/[^A-Za-z]/g, "");
        const prefix = safeName.length >= 4 ? safeName.substring(0, 4).toUpperCase() : (safeName.toUpperCase() + "SOC1").substring(0, 4);
        const code = prefix + Math.floor(1000 + Math.random() * 9000);
        // Create the new Tenant
        const tenant = await prisma_1.default.tenant.create({
            data: {
                name: data.societyName,
                code: code,
                plan: "starter",
                status: "active"
            }
        });
        const passwordHash = await bcrypt_1.default.hash(data.password, 12);
        // Create the Admin User
        const user = await prisma_1.default.user.create({
            data: {
                email: data.email,
                name: data.adminName,
                passwordHash,
                role: "admin",
                tenantId: tenant.id,
                status: "active"
            }
        });
        res.status(201).json({
            success: true,
            tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
            user: { id: user.id, email: user.email, name: user.name, role: user.role }
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
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
            res.status(400).json({ success: false, errors: err.issues });
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
// RSK-005: POST /api/v1/auth/change-password — Change password with history check
router.post("/change-password", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const token = authHeader.split(" ")[1];
        const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET || "fallback_secret");
        const user = await prisma_1.default.user.findUnique({ where: { id: payload.userId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        const { currentPassword, newPassword } = zod_1.z.object({
            currentPassword: zod_1.z.string().min(6),
            newPassword: zod_1.z.string().min(8),
        }).parse(req.body);
        // Verify current password
        const valid = await bcrypt_1.default.compare(currentPassword, user.passwordHash);
        if (!valid) {
            res.status(401).json({ success: false, message: "Current password is incorrect" });
            return;
        }
        // RSK-005: Check password history (last 5 passwords)
        const passwordHistory = await prisma_1.default.passwordHistory.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
            take: 5,
        });
        for (const hist of passwordHistory) {
            const matches = await bcrypt_1.default.compare(newPassword, hist.passwordHash);
            if (matches) {
                res.status(400).json({ success: false, message: "New password cannot be one of the last 5 passwords" });
                return;
            }
        }
        // Hash new password
        const newPasswordHash = await bcrypt_1.default.hash(newPassword, 12);
        // Update password and reset expiry
        await prisma_1.default.user.update({
            where: { id: user.id },
            data: {
                passwordHash: newPasswordHash,
                passwordChangedAt: new Date(),
                passwordForceExpire: false,
            },
        });
        // Add to password history
        await prisma_1.default.passwordHistory.create({
            data: {
                userId: user.id,
                passwordHash: newPasswordHash,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId: user.tenantId ?? undefined,
            userId: user.id,
            action: "PASSWORD_CHANGED",
            entity: "User",
            entityId: user.id,
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "Password changed successfully" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Auth] Change password error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map