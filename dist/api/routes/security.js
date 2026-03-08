"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Module 9 — Security & RBAC Routes
 * SEC-001: RBAC Permission Matrix
 * SEC-002: Multi-Factor Authentication (TOTP)
 * SEC-005: DPDP Act 2023 Compliance
 */
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const crypto = __importStar(require("crypto"));
const speakeasy_1 = __importDefault(require("speakeasy"));
const qrcode_1 = __importDefault(require("qrcode"));
const router = (0, express_1.Router)();
// ─────────────────────────────────────────────
// SEC-001: Role-Based Access Control (RBAC)
// ─────────────────────────────────────────────
// GET /api/v1/security/permissions — Get permission matrix for tenant
router.get("/permissions", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const matrices = await prisma_1.default.permissionMatrix.findMany({
            where: { tenantId, isActive: true },
            orderBy: { role: "asc" },
        });
        res.json({ success: true, data: matrices });
    }
    catch (err) {
        console.error("[Security] Get permissions error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/permissions — Create/update permission matrix
router.post("/permissions", auth_1.authMiddleware, auth_1.requireTenant, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const { role, permissions } = zod_1.z.object({
            role: zod_1.z.string(),
            permissions: zod_1.z.array(zod_1.z.string()),
        }).parse(req.body);
        const tenantId = req.user.tenantId;
        const matrix = await prisma_1.default.permissionMatrix.upsert({
            where: { tenantId_role: { tenantId, role } },
            update: { permissions, updatedAt: new Date() },
            create: { tenantId, role, permissions },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "PERMISSION_MATRIX_UPDATED",
            entity: "PermissionMatrix",
            entityId: matrix.id,
            newData: { role, permissions },
        });
        res.json({ success: true, data: matrix });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] Update permissions error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/roles/assign — Assign role to user
router.post("/roles/assign", auth_1.authMiddleware, auth_1.requireTenant, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const { userId, role, reason } = zod_1.z.object({
            userId: zod_1.z.string(),
            role: zod_1.z.string(),
            reason: zod_1.z.string().optional(),
        }).parse(req.body);
        const tenantId = req.user.tenantId;
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user || user.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        await prisma_1.default.user.update({
            where: { id: userId },
            data: { role },
        });
        await prisma_1.default.roleAssignmentLog.create({
            data: {
                tenantId,
                userId,
                assignedRole: role,
                assignedBy: req.user.userId,
                reason,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "ROLE_ASSIGNED",
            entity: "User",
            entityId: userId,
            newData: { role, reason },
        });
        res.json({ success: true, message: "Role assigned successfully" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] Assign role error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/security/roles/assignments — Get role assignment history
router.get("/roles/assignments", auth_1.authMiddleware, auth_1.requireTenant, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const assignments = await prisma_1.default.roleAssignmentLog.findMany({
            where: { tenantId },
            include: { user: { select: { id: true, name: true, email: true } }, assigner: { select: { id: true, name: true } } },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        res.json({ success: true, data: assignments });
    }
    catch (err) {
        console.error("[Security] Get assignments error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─────────────────────────────────────────────
// SEC-002: Multi-Factor Authentication (MFA)
// ─────────────────────────────────────────────
// POST /api/v1/security/mfa/setup — Setup TOTP MFA
router.post("/mfa/setup", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        // Generate TOTP secret
        const secret = speakeasy_1.default.generateSecret({
            name: `Sahayog AI (${user.email})`,
            issuer: "Sahayog AI",
        });
        // Generate backup codes
        const backupCodes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString("hex").toUpperCase());
        // Generate QR code URL
        const qrCodeUrl = await qrcode_1.default.toDataURL(secret.otpauth_url || "");
        // Store secret temporarily (not enabled yet)
        await prisma_1.default.user.update({
            where: { id: userId },
            data: {
                totpSecret: secret.base32,
                totpBackupCodes: backupCodes,
                mfaMethod: "TOTP",
                // mfaEnabled remains false until verified
            },
        });
        await prisma_1.default.mfaLog.create({
            data: {
                userId,
                tenantId: user.tenantId,
                action: "SETUP",
                method: "TOTP",
                success: true,
                ipAddress: req.ip,
                userAgent: req.headers["user-agent"] || undefined,
            },
        });
        res.json({
            success: true,
            data: {
                secret: secret.base32,
                qrCodeUrl,
                backupCodes,
                manualEntryKey: secret.base32,
            },
        });
    }
    catch (err) {
        console.error("[Security] MFA setup error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/mfa/verify — Verify TOTP code and enable MFA
router.post("/mfa/verify", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { code, backupCode } = zod_1.z.object({
            code: zod_1.z.string().optional(),
            backupCode: zod_1.z.string().optional(),
        }).parse(req.body);
        const userId = req.user.userId;
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user || !user.totpSecret) {
            res.status(400).json({ success: false, message: "MFA not set up" });
            return;
        }
        let verified = false;
        if (backupCode && user.totpBackupCodes.includes(backupCode)) {
            // Verify backup code
            verified = true;
            // Remove used backup code
            const updatedBackupCodes = user.totpBackupCodes.filter((c) => c !== backupCode);
            await prisma_1.default.user.update({
                where: { id: userId },
                data: { totpBackupCodes: updatedBackupCodes },
            });
        }
        else if (code) {
            // Verify TOTP code
            verified = speakeasy_1.default.totp.verify({
                secret: user.totpSecret,
                encoding: "base32",
                token: code,
                window: 2, // Allow 2 time steps tolerance
            });
        }
        if (!verified) {
            await prisma_1.default.mfaLog.create({
                data: {
                    userId,
                    tenantId: user.tenantId,
                    action: "VERIFY",
                    method: "TOTP",
                    success: false,
                    ipAddress: req.ip,
                    userAgent: req.headers["user-agent"] || undefined,
                },
            });
            res.status(401).json({ success: false, message: "Invalid code" });
            return;
        }
        // Enable MFA
        await prisma_1.default.user.update({
            where: { id: userId },
            data: {
                mfaEnabled: true,
                mfaVerifiedAt: new Date(),
            },
        });
        await prisma_1.default.mfaLog.create({
            data: {
                userId,
                tenantId: user.tenantId,
                action: "VERIFY",
                method: "TOTP",
                success: true,
                ipAddress: req.ip,
                userAgent: req.headers["user-agent"] || undefined,
            },
        });
        res.json({ success: true, message: "MFA enabled successfully" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] MFA verify error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/mfa/disable — Disable MFA
router.post("/mfa/disable", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        await prisma_1.default.user.update({
            where: { id: userId },
            data: {
                mfaEnabled: false,
                totpSecret: null,
                totpBackupCodes: [],
                mfaMethod: null,
                mfaVerifiedAt: null,
            },
        });
        await prisma_1.default.mfaLog.create({
            data: {
                userId,
                tenantId: user.tenantId,
                action: "DISABLE",
                method: user.mfaMethod || "TOTP",
                success: true,
                ipAddress: req.ip,
                userAgent: req.headers["user-agent"] || undefined,
            },
        });
        res.json({ success: true, message: "MFA disabled successfully" });
    }
    catch (err) {
        console.error("[Security] MFA disable error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/security/mfa/status — Get MFA status
router.get("/mfa/status", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const userId = req.user.userId;
        const user = await prisma_1.default.user.findUnique({
            where: { id: userId },
            select: { mfaEnabled: true, mfaMethod: true, totpBackupCodes: true },
        });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        res.json({
            success: true,
            data: {
                mfaEnabled: user.mfaEnabled,
                mfaMethod: user.mfaMethod,
                backupCodesRemaining: user.totpBackupCodes?.length || 0,
            },
        });
    }
    catch (err) {
        console.error("[Security] MFA status error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─────────────────────────────────────────────
// SEC-005: DPDP Act 2023 Compliance
// ─────────────────────────────────────────────
// POST /api/v1/security/dpdp/access-request — Submit data access request
router.post("/dpdp/access-request", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { memberId } = zod_1.z.object({ memberId: zod_1.z.string() }).parse(req.body);
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findUnique({ where: { id: memberId } });
        if (!member || member.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Check if user is the member or has permission
        if (req.user.role !== "member" && req.user.userId !== memberId) {
            // For staff/admin, they can request on behalf of member
            // But we log it
        }
        const request = await prisma_1.default.dataAccessRequest.create({
            data: {
                tenantId,
                memberId,
                requestType: "ACCESS",
                status: "PENDING",
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "DATA_ACCESS_REQUEST_CREATED",
            entity: "DataAccessRequest",
            entityId: request.id,
            newData: { memberId },
        });
        res.json({ success: true, data: request });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] DPDP access request error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/security/dpdp/access-requests — List data access requests
router.get("/dpdp/access-requests", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const requests = await prisma_1.default.dataAccessRequest.findMany({
            where: { tenantId },
            include: { member: { select: { id: true, firstName: true, lastName: true, memberNumber: true } } },
            orderBy: { requestedAt: "desc" },
        });
        res.json({ success: true, data: requests });
    }
    catch (err) {
        console.error("[Security] Get access requests error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/dpdp/access-requests/:id/fulfill — Fulfill data access request
router.post("/dpdp/access-requests/:id/fulfill", auth_1.authMiddleware, auth_1.requireTenant, (0, auth_1.requireRole)("admin", "secretary"), async (req, res) => {
    try {
        const { id } = req.params;
        const tenantId = req.user.tenantId;
        const request = await prisma_1.default.dataAccessRequest.findUnique({ where: { id } });
        if (!request || request.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Request not found" });
            return;
        }
        // Collect all member data
        const member = await prisma_1.default.member.findUnique({
            where: { id: request.memberId },
            include: {
                shareLedger: true,
                nominees: true,
                sbAccounts: true,
                deposits: true,
                loans: true,
            },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Update request
        const updated = await prisma_1.default.dataAccessRequest.update({
            where: { id },
            data: {
                status: "FULFILLED",
                fulfilledAt: new Date(),
                fulfilledBy: req.user.userId,
                responseData: member,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "DATA_ACCESS_REQUEST_FULFILLED",
            entity: "DataAccessRequest",
            entityId: id,
            newData: { memberId: request.memberId },
        });
        res.json({ success: true, data: updated });
    }
    catch (err) {
        console.error("[Security] Fulfill access request error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/dpdp/correction-request — Submit data correction request
router.post("/dpdp/correction-request", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { memberId, field, newValue, reason } = zod_1.z.object({
            memberId: zod_1.z.string(),
            field: zod_1.z.string(),
            newValue: zod_1.z.string(),
            reason: zod_1.z.string().optional(),
        }).parse(req.body);
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findUnique({ where: { id: memberId } });
        if (!member || member.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const oldValue = member[field] || null;
        const request = await prisma_1.default.dataCorrectionRequest.create({
            data: {
                tenantId,
                memberId,
                field,
                oldValue: oldValue?.toString() || null,
                newValue,
                reason,
                status: "PENDING",
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "DATA_CORRECTION_REQUEST_CREATED",
            entity: "DataCorrectionRequest",
            entityId: request.id,
            newData: { memberId, field },
        });
        res.json({ success: true, data: request });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] DPDP correction request error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/dpdp/correction-requests/:id/approve — Approve data correction
router.post("/dpdp/correction-requests/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, (0, auth_1.requireRole)("admin", "secretary"), async (req, res) => {
    try {
        const { id } = req.params;
        const tenantId = req.user.tenantId;
        const request = await prisma_1.default.dataCorrectionRequest.findUnique({ where: { id } });
        if (!request || request.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Request not found" });
            return;
        }
        // Update member field
        const updateData = { [request.field]: request.newValue };
        await prisma_1.default.member.update({
            where: { id: request.memberId },
            data: updateData,
        });
        // Update request
        const updated = await prisma_1.default.dataCorrectionRequest.update({
            where: { id },
            data: {
                status: "APPROVED",
                processedAt: new Date(),
                processedBy: req.user.userId,
                auditTrail: {
                    oldValue: request.oldValue,
                    newValue: request.newValue,
                    changedBy: req.user.userId,
                    changedAt: new Date(),
                },
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "DATA_CORRECTION_APPROVED",
            entity: "DataCorrectionRequest",
            entityId: id,
            newData: { memberId: request.memberId, field: request.field },
        });
        res.json({ success: true, data: updated });
    }
    catch (err) {
        console.error("[Security] Approve correction error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/dpdp/erasure-request — Submit data erasure request
router.post("/dpdp/erasure-request", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { memberId, erasureType, reason } = zod_1.z.object({
            memberId: zod_1.z.string(),
            erasureType: zod_1.z.enum(["FULL", "PARTIAL", "ANONYMIZE"]),
            reason: zod_1.z.string().optional(),
        }).parse(req.body);
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findUnique({ where: { id: memberId } });
        if (!member || member.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const request = await prisma_1.default.dataErasureRequest.create({
            data: {
                tenantId,
                memberId,
                erasureType,
                reason,
                status: "PENDING",
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "DATA_ERASURE_REQUEST_CREATED",
            entity: "DataErasureRequest",
            entityId: request.id,
            newData: { memberId, erasureType },
        });
        res.json({ success: true, data: request });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] DPDP erasure request error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/dpdp/erasure-requests/:id/process — Process data erasure
router.post("/dpdp/erasure-requests/:id/process", auth_1.authMiddleware, auth_1.requireTenant, (0, auth_1.requireRole)("admin"), async (req, res) => {
    try {
        const { id } = req.params;
        const tenantId = req.user.tenantId;
        const request = await prisma_1.default.dataErasureRequest.findUnique({ where: { id } });
        if (!request || request.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Request not found" });
            return;
        }
        const member = await prisma_1.default.member.findUnique({ where: { id: request.memberId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const anonymizedFields = [];
        const deletedFields = [];
        const retentionFields = ["id", "tenantId", "memberNumber"]; // Legal compliance fields
        // Anonymize or delete based on erasure type
        if (request.erasureType === "FULL") {
            // Anonymize all PII fields
            await prisma_1.default.member.update({
                where: { id: request.memberId },
                data: {
                    firstName: "ANONYMIZED",
                    lastName: "ANONYMIZED",
                    email: `anonymized_${member.id}@deleted.local`,
                    phone: "0000000000",
                    aadhaar: null,
                    pan: null,
                    address: "ANONYMIZED",
                    city: "ANONYMIZED",
                    state: "ANONYMIZED",
                    pincode: "000000",
                },
            });
            anonymizedFields.push("firstName", "lastName", "email", "phone", "aadhaar", "pan", "address", "city", "state", "pincode");
        }
        else if (request.erasureType === "PARTIAL") {
            // Partial anonymization based on request
            // This would be configurable
        }
        else if (request.erasureType === "ANONYMIZE") {
            // Anonymize sensitive fields only
            await prisma_1.default.member.update({
                where: { id: request.memberId },
                data: {
                    aadhaar: null,
                    pan: null,
                    email: `anonymized_${member.id}@deleted.local`,
                },
            });
            anonymizedFields.push("aadhaar", "pan", "email");
        }
        const updated = await prisma_1.default.dataErasureRequest.update({
            where: { id },
            data: {
                status: "COMPLETED",
                processedAt: new Date(),
                processedBy: req.user.userId,
                anonymizedFields,
                deletedFields,
                retentionFields,
                erasureLog: {
                    processedBy: req.user.userId,
                    processedAt: new Date(),
                    anonymizedFields,
                    deletedFields,
                    retentionFields,
                },
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: "DATA_ERASURE_PROCESSED",
            entity: "DataErasureRequest",
            entityId: id,
            newData: { memberId: request.memberId, erasureType: request.erasureType },
        });
        res.json({ success: true, data: updated });
    }
    catch (err) {
        console.error("[Security] Process erasure error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/security/dpdp/consent — Record consent
router.post("/dpdp/consent", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { memberId, purpose, consentGiven } = zod_1.z.object({
            memberId: zod_1.z.string(),
            purpose: zod_1.z.string(),
            consentGiven: zod_1.z.boolean(),
        }).parse(req.body);
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findUnique({ where: { id: memberId } });
        if (!member || member.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const consent = await prisma_1.default.consentRecord.upsert({
            where: { tenantId_memberId_purpose: { tenantId, memberId, purpose } },
            update: {
                consentGiven,
                consentDate: consentGiven ? new Date() : undefined,
                withdrawalDate: !consentGiven ? new Date() : undefined,
                method: "ONLINE",
                ipAddress: req.ip,
            },
            create: {
                tenantId,
                memberId,
                purpose,
                consentGiven,
                consentDate: consentGiven ? new Date() : undefined,
                method: "ONLINE",
                ipAddress: req.ip,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user.userId,
            action: consentGiven ? "CONSENT_GIVEN" : "CONSENT_WITHDRAWN",
            entity: "ConsentRecord",
            entityId: consent.id,
            newData: { memberId, purpose },
        });
        res.json({ success: true, data: consent });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] Consent error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/security/dpdp/consent — Get consent records
router.get("/dpdp/consent", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { memberId } = zod_1.z.object({ memberId: zod_1.z.string() }).parse(req.query);
        const tenantId = req.user.tenantId;
        const consents = await prisma_1.default.consentRecord.findMany({
            where: { tenantId, memberId },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: consents });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Security] Get consent error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=security.js.map