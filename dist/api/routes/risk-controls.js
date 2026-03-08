"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTransactionVelocity = checkTransactionVelocity;
exports.checkDailyLimit = checkDailyLimit;
/**
 * Module 8: Risk & Controls Routes
 * RSK-001 through RSK-012
 */
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const crypto_1 = __importDefault(require("crypto"));
const router = (0, express_1.Router)();
// Helper: Get config value with default
async function getConfig(tenantId, key, defaultValue) {
    const config = await prisma_1.default.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key } },
    });
    return config?.value || defaultValue;
}
// Helper: Get config as number
async function getConfigNumber(tenantId, key, defaultValue) {
    const value = await getConfig(tenantId, key, defaultValue.toString());
    return parseFloat(value) || defaultValue;
}
// RSK-001: Transaction Velocity Check Middleware
async function checkTransactionVelocity(tenantId, accountId, transactionType, amount) {
    const windowMinutes = await getConfigNumber(tenantId, "velocity.check.window.minutes", 5);
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    // Check for duplicate transactions
    const recentCount = await prisma_1.default.transactionVelocity.count({
        where: {
            tenantId,
            accountId,
            transactionType,
            amount,
            createdAt: { gte: windowStart },
        },
    });
    if (recentCount > 0) {
        // Record velocity violation
        const velocityRecord = await prisma_1.default.transactionVelocity.create({
            data: {
                tenantId,
                accountId,
                transactionType,
                amount,
            },
        });
        return {
            allowed: false,
            reason: `Duplicate transaction detected: same account, amount (₹${amount.toLocaleString("en-IN")}), and type within ${windowMinutes} minutes`,
            velocityId: velocityRecord.id,
        };
    }
    // Record this transaction
    await prisma_1.default.transactionVelocity.create({
        data: {
            tenantId,
            accountId,
            transactionType,
            amount,
        },
    });
    return { allowed: true };
}
// RSK-002: Check Daily Transaction Limits
async function checkDailyLimit(tenantId, userId, accountId, amount, limitType) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limitKey = limitType === "USER_CASH" ? "transaction.daily.limit.cash" : "transaction.daily.limit.cash";
    const defaultLimit = limitType === "USER_CASH" ? 50000 : 100000;
    const limitAmount = await getConfigNumber(tenantId, limitKey, defaultLimit);
    // Get or create daily limit record
    const dailyLimit = await prisma_1.default.dailyLimit.upsert({
        where: {
            tenantId_userId_accountId_limitType_date: {
                tenantId,
                userId: userId || "",
                accountId: accountId || "",
                limitType,
                date: today,
            },
        },
        create: {
            tenantId,
            userId: userId || null,
            accountId: accountId || null,
            limitType,
            date: today,
            amountUsed: 0,
            limitAmount,
        },
        update: {},
    });
    const newAmountUsed = Number(dailyLimit.amountUsed) + amount;
    const remaining = limitAmount - newAmountUsed;
    if (newAmountUsed > limitAmount) {
        return {
            allowed: false,
            remaining: Math.max(0, remaining),
            reason: `Daily ${limitType === "USER_CASH" ? "user" : "account"} limit exceeded. Limit: ₹${limitAmount.toLocaleString("en-IN")}, Used: ₹${Number(dailyLimit.amountUsed).toLocaleString("en-IN")}, Remaining: ₹${remaining.toLocaleString("en-IN")}`,
        };
    }
    // Update amount used
    await prisma_1.default.dailyLimit.update({
        where: { id: dailyLimit.id },
        data: { amountUsed: newAmountUsed },
    });
    return { allowed: true, remaining };
}
// RSK-003: GET /api/v1/risk-controls/sessions — List active sessions
router.get("/sessions", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.query.userId;
        const where = { tenantId };
        if (userId)
            where.userId = userId;
        const sessions = await prisma_1.default.session.findMany({
            where,
            include: { user: { select: { id: true, name: true, email: true, role: true } } },
            orderBy: { lastActivityAt: "desc" },
        });
        res.json({ success: true, sessions });
    }
    catch (err) {
        console.error("[Risk Controls Sessions]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-003: DELETE /api/v1/risk-controls/sessions/:id — Force logout session
router.delete("/sessions/:id", auth_1.authMiddleware, (0, auth_1.requireRole)("admin", "superadmin"), async (req, res) => {
    try {
        const sessionId = req.params.id;
        await prisma_1.default.session.delete({ where: { id: sessionId } });
        res.json({ success: true, message: "Session terminated" });
    }
    catch (err) {
        console.error("[Risk Controls Session Delete]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-002: GET /api/v1/risk-controls/daily-limits — Get daily limit status
router.get("/daily-limits", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.query.userId;
        const accountId = req.query.accountId;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const limits = await prisma_1.default.dailyLimit.findMany({
            where: {
                tenantId,
                userId: userId || undefined,
                accountId: accountId || undefined,
                date: today,
            },
        });
        res.json({ success: true, limits });
    }
    catch (err) {
        console.error("[Risk Controls Daily Limits]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-005: GET /api/v1/risk-controls/password-expiry — Check password expiry status
router.get("/password-expiry", auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        const tenantId = user.tenantId || "";
        const expiryDays = await getConfigNumber(tenantId, "password.expiry.days", 90);
        const passwordChangedAt = user.passwordChangedAt || user.createdAt;
        const daysSinceChange = Math.floor((Date.now() - passwordChangedAt.getTime()) / (24 * 60 * 60 * 1000));
        const daysUntilExpiry = expiryDays - daysSinceChange;
        let alertLevel = "NONE";
        if (user.passwordForceExpire || daysUntilExpiry <= 0) {
            alertLevel = "EXPIRED";
        }
        else if (daysUntilExpiry <= 1) {
            alertLevel = "CRITICAL";
        }
        else if (daysUntilExpiry <= 7) {
            alertLevel = "WARNING";
        }
        res.json({
            success: true,
            passwordChangedAt: passwordChangedAt.toISOString(),
            daysUntilExpiry,
            alertLevel,
            forceExpired: user.passwordForceExpire,
        });
    }
    catch (err) {
        console.error("[Risk Controls Password Expiry]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-005: POST /api/v1/risk-controls/password-expiry/:userId/force-expire — Force expire password
router.post("/password-expiry/:userId/force-expire", auth_1.authMiddleware, (0, auth_1.requireRole)("admin", "superadmin"), async (req, res) => {
    try {
        const userId = req.params.userId;
        await prisma_1.default.user.update({
            where: { id: userId },
            data: { passwordForceExpire: true },
        });
        await (0, audit_1.createAuditLog)({
            tenantId: req.user?.tenantId,
            userId: req.user?.userId,
            action: "FORCE_PASSWORD_EXPIRE",
            entity: "User",
            entityId: userId,
        });
        res.json({ success: true, message: "Password force expired" });
    }
    catch (err) {
        console.error("[Risk Controls Force Password Expire]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-006: POST /api/v1/risk-controls/data-masking/unmask — Log unmask action
router.post("/data-masking/unmask", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const { field, entityType, entityId, purpose } = zod_1.z.object({
            field: zod_1.z.enum(["aadhaar", "pan", "bank_account", "mobile"]),
            entityType: zod_1.z.string(),
            entityId: zod_1.z.string(),
            purpose: zod_1.z.string().optional(),
        }).parse(req.body);
        // Check permissions based on field
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        const role = user?.role || "";
        const allowedRoles = {
            aadhaar: ["secretary", "admin", "superadmin"],
            pan: ["accountant", "admin", "superadmin"],
            bank_account: ["accountant", "admin", "superadmin"],
            mobile: ["secretary", "admin", "superadmin"],
        };
        if (!allowedRoles[field]?.includes(role.toLowerCase())) {
            res.status(403).json({ success: false, message: "Insufficient permissions to unmask this field" });
            return;
        }
        await prisma_1.default.dataMaskingLog.create({
            data: {
                tenantId,
                userId,
                field,
                entityType,
                entityId,
                purpose,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId,
            action: "DATA_UNMASK",
            entity: entityType,
            entityId,
            newData: { field, purpose },
        });
        res.json({ success: true, message: "Unmask action logged" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Risk Controls Data Masking]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-007: GET /api/v1/risk-controls/backup-verification — Get backup verification status
router.get("/backup-verification", auth_1.authMiddleware, (0, auth_1.requireRole)("admin", "superadmin"), async (req, res) => {
    try {
        const { days = 7 } = req.query;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - Number(days));
        const verifications = await prisma_1.default.backupVerification.findMany({
            where: { verificationDate: { gte: startDate } },
            orderBy: { verificationDate: "desc" },
        });
        res.json({ success: true, verifications });
    }
    catch (err) {
        console.error("[Risk Controls Backup Verification]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-010: GET /api/v1/risk-controls/audit-log-hash-chain — Verify audit log hash chain
router.get("/audit-log-hash-chain", auth_1.authMiddleware, (0, auth_1.requireRole)("auditor", "admin", "superadmin"), async (req, res) => {
    try {
        const { from, to } = req.query;
        const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const toDate = to ? new Date(to) : new Date();
        const auditLogs = await prisma_1.default.auditLog.findMany({
            where: { createdAt: { gte: fromDate, lte: toDate } },
            orderBy: { createdAt: "asc" },
            take: 1000,
        });
        const hashChain = [];
        let previousHash = null;
        for (const log of auditLogs) {
            const hashRecord = await prisma_1.default.auditLogHash.findUnique({
                where: { auditLogId: log.id },
            });
            if (hashRecord) {
                const logContent = JSON.stringify({
                    id: log.id,
                    action: log.action,
                    entity: log.entity,
                    entityId: log.entityId,
                    oldData: log.oldData,
                    newData: log.newData,
                    previousHash,
                });
                const computedHash = crypto_1.default.createHash("sha256").update(logContent).digest("hex");
                const isValid = computedHash === hashRecord.hash && hashRecord.previousHash === previousHash;
                hashChain.push({
                    auditLogId: log.id,
                    hash: hashRecord.hash,
                    isValid,
                });
                previousHash = hashRecord.hash;
            }
        }
        const allValid = hashChain.every((h) => h.isValid);
        res.json({
            success: true,
            totalLogs: auditLogs.length,
            hashChainLength: hashChain.length,
            allValid,
            hashChain,
        });
    }
    catch (err) {
        console.error("[Risk Controls Audit Log Hash Chain]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-011: GET /api/v1/risk-controls/data-retention — Get data retention status
router.get("/data-retention", auth_1.authMiddleware, (0, auth_1.requireRole)("admin", "superadmin"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { category, status } = req.query;
        const where = {};
        if (tenantId)
            where.tenantId = tenantId;
        if (category)
            where.dataCategory = category;
        if (status)
            where.status = status;
        const retention = await prisma_1.default.dataRetention.findMany({
            where,
            orderBy: { retentionUntil: "asc" },
            take: 100,
        });
        res.json({ success: true, retention });
    }
    catch (err) {
        console.error("[Risk Controls Data Retention]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-012: GET /api/v1/risk-controls/aml-alerts — Get AML alerts
router.get("/aml-alerts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status = "PENDING" } = req.query;
        // Check if table exists, return empty array if not
        let alerts = [];
        try {
            alerts = await prisma_1.default.amlAlert.findMany({
                where: {
                    tenantId,
                    status: status,
                },
                include: {
                    member: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            memberNumber: true,
                        },
                    },
                },
                orderBy: { createdAt: "desc" },
                take: 100,
            });
        }
        catch (err) {
            // Table doesn't exist yet, return empty array
            if (err.code === 'P2021' || err.message?.includes('does not exist')) {
                console.warn("[Risk Controls AML Alerts] Table aml_alerts does not exist yet");
                alerts = [];
            }
            else {
                throw err;
            }
        }
        res.json({ success: true, alerts });
    }
    catch (err) {
        console.error("[Risk Controls AML Alerts]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// RSK-012: POST /api/v1/risk-controls/aml-alerts/:id/review — Review AML alert
router.post("/aml-alerts/:id/review", auth_1.authMiddleware, (0, auth_1.requireRole)("compliance_officer", "admin", "superadmin"), async (req, res) => {
    try {
        const alertId = req.params.id;
        const { action, notes } = zod_1.z.object({
            action: zod_1.z.enum(["REVIEWED", "DISMISSED", "STR_GENERATED"]),
            notes: zod_1.z.string().optional(),
        }).parse(req.body);
        await prisma_1.default.amlAlert.update({
            where: { id: alertId },
            data: {
                status: action,
                reviewedBy: req.user?.userId,
                reviewedAt: new Date(),
                strGenerated: action === "STR_GENERATED",
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId: req.user?.tenantId,
            userId: req.user?.userId,
            action: "AML_ALERT_REVIEWED",
            entity: "AmlAlert",
            entityId: alertId,
            newData: { action, notes },
        });
        res.json({ success: true, message: "Alert reviewed" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Risk Controls AML Alert Review]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=risk-controls.js.map