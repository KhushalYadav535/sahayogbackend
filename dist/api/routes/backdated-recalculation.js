"use strict";
/**
 * Backdated Interest Recalculation API (BRD v4.0 INT-010)
 * Maker-Checker workflow for backdated recalculation requests
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const backdated_recalculation_service_1 = require("../../services/backdated-recalculation.service");
const audit_1 = require("../../db/audit");
const router = (0, express_1.Router)();
// POST /api/v1/recalculation/request — Request backdated recalculation (Maker)
router.post("/request", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const { accountId, accountType, effectiveFromDate, reason } = zod_1.z.object({
            accountId: zod_1.z.string(),
            accountType: zod_1.z.enum(["SB", "FDR", "RD"]),
            effectiveFromDate: zod_1.z.string().transform((s) => new Date(s)),
            reason: zod_1.z.string().min(10, "Reason must be at least 10 characters"),
        }).parse(req.body);
        // Check if recalculation is already in progress
        const inProgress = await (0, backdated_recalculation_service_1.isRecalculationInProgress)(tenantId, accountId, accountType);
        if (inProgress) {
            res.status(409).json({
                success: false,
                message: "Recalculation already in progress for this account",
            });
            return;
        }
        // Validate account exists
        let account;
        if (accountType === "SB") {
            account = await prisma_1.default.sbAccount.findFirst({
                where: { id: accountId, tenantId },
            });
        }
        else {
            account = await prisma_1.default.deposit.findFirst({
                where: { id: accountId, tenantId, depositType: accountType.toLowerCase() },
            });
        }
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        // Create recalculation request (DRAFT status)
        const request = await prisma_1.default.recalculationRequest.create({
            data: {
                tenantId,
                accountId,
                accountType,
                effectiveFromDate,
                reason,
                requestedBy: userId,
                status: "DRAFT",
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId,
            action: "RECALCULATION_REQUEST_CREATED",
            entity: accountType === "SB" ? "SbAccount" : "Deposit",
            entityId: accountId,
            newData: { requestId: request.id, effectiveFromDate, reason },
            ipAddress: req.ip,
        });
        res.json({
            success: true,
            message: "Recalculation request created",
            requestId: request.id,
            status: "DRAFT",
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Recalculation Request]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/recalculation/:id/submit — Submit for approval
router.put("/:id/submit", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const request = await prisma_1.default.recalculationRequest.findFirst({
            where: { id: req.params.id, tenantId, status: "DRAFT" },
        });
        if (!request) {
            res.status(404).json({ success: false, message: "Request not found or already submitted" });
            return;
        }
        // Update status to PENDING_APPROVAL
        await prisma_1.default.recalculationRequest.update({
            where: { id: request.id },
            data: {
                status: "PENDING_APPROVAL",
                submittedAt: new Date(),
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId,
            action: "RECALCULATION_REQUEST_SUBMITTED",
            entity: "RecalculationRequest",
            entityId: request.id,
            newData: { status: "PENDING_APPROVAL" },
            ipAddress: req.ip,
        });
        res.json({
            success: true,
            message: "Request submitted for approval",
            requestId: request.id,
        });
    }
    catch (err) {
        console.error("[Recalculation Submit]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/recalculation/:id/approve — Approve and execute (Checker)
router.put("/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const request = await prisma_1.default.recalculationRequest.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });
        if (!request) {
            res.status(404).json({ success: false, message: "Request not found or not pending approval" });
            return;
        }
        // Execute recalculation
        const result = await (0, backdated_recalculation_service_1.recalculateInterest)({
            tenantId,
            accountId: request.accountId,
            accountType: request.accountType,
            effectiveFromDate: request.effectiveFromDate,
            reason: request.reason,
            requestedBy: request.requestedBy,
        });
        if (!result.success) {
            // Update request status to REJECTED
            await prisma_1.default.recalculationRequest.update({
                where: { id: request.id },
                data: {
                    status: "REJECTED",
                    rejectedAt: new Date(),
                    rejectionReason: result.error || "Recalculation failed",
                },
            });
            res.status(400).json({
                success: false,
                message: result.error || "Recalculation failed",
            });
            return;
        }
        // Update request status to APPROVED
        await prisma_1.default.recalculationRequest.update({
            where: { id: request.id },
            data: {
                status: "APPROVED",
                approvedAt: new Date(),
                approvedBy: userId,
                reversalCount: result.reversalCount,
                recalculationCount: result.recalculationCount,
                netDifference: result.netDifference,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId,
            action: "RECALCULATION_APPROVED",
            entity: "RecalculationRequest",
            entityId: request.id,
            newData: {
                status: "APPROVED",
                reversalCount: result.reversalCount,
                recalculationCount: result.recalculationCount,
                netDifference: result.netDifference,
            },
            ipAddress: req.ip,
        });
        res.json({
            success: true,
            message: "Recalculation approved and executed",
            result: {
                reversalCount: result.reversalCount,
                recalculationCount: result.recalculationCount,
                netDifference: result.netDifference,
            },
        });
    }
    catch (err) {
        console.error("[Recalculation Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/recalculation/:id/reject — Reject request (Checker)
router.put("/:id/reject", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const { rejectionReason } = zod_1.z.object({
            rejectionReason: zod_1.z.string().min(10, "Rejection reason must be at least 10 characters"),
        }).parse(req.body);
        const request = await prisma_1.default.recalculationRequest.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });
        if (!request) {
            res.status(404).json({ success: false, message: "Request not found or not pending approval" });
            return;
        }
        await prisma_1.default.recalculationRequest.update({
            where: { id: request.id },
            data: {
                status: "REJECTED",
                rejectedAt: new Date(),
                rejectedBy: userId,
                rejectionReason,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId,
            action: "RECALCULATION_REJECTED",
            entity: "RecalculationRequest",
            entityId: request.id,
            newData: { status: "REJECTED", rejectionReason },
            ipAddress: req.ip,
        });
        res.json({
            success: true,
            message: "Recalculation request rejected",
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Recalculation Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/recalculation/pending — Get pending requests
router.get("/pending", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const requests = await prisma_1.default.recalculationRequest.findMany({
            where: { tenantId, status: "PENDING_APPROVAL" },
            orderBy: { submittedAt: "asc" },
            include: {
                requester: {
                    select: { name: true, email: true },
                },
            },
        });
        res.json({
            success: true,
            requests,
        });
    }
    catch (err) {
        console.error("[Recalculation Pending]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=backdated-recalculation.js.map