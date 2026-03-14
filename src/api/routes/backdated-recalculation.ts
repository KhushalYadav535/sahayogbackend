/**
 * Backdated Interest Recalculation API (BRD v4.0 INT-010)
 * Maker-Checker workflow for backdated recalculation requests
 */

import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { recalculateInterest, isRecalculationInProgress } from "../../services/backdated-recalculation.service";
import { createAuditLog } from "../../db/audit";

const router = Router();

// POST /api/v1/recalculation/request — Request backdated recalculation (Maker)
router.post("/request", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.userId!;

        const { accountId, accountType, effectiveFromDate, reason } = z.object({
            accountId: z.string(),
            accountType: z.enum(["SB", "FDR", "RD"]),
            effectiveFromDate: z.string().transform((s) => new Date(s)),
            reason: z.string().min(10, "Reason must be at least 10 characters"),
        }).parse(req.body);

        // Check if recalculation is already in progress
        const inProgress = await isRecalculationInProgress(tenantId, accountId, accountType);
        if (inProgress) {
            res.status(409).json({
                success: false,
                message: "Recalculation already in progress for this account",
            });
            return;
        }

        // Validate account exists
        let account: any;
        if (accountType === "SB") {
            account = await prisma.sbAccount.findFirst({
                where: { id: accountId, tenantId },
            });
        } else {
            account = await prisma.deposit.findFirst({
                where: { id: accountId, tenantId, depositType: accountType.toLowerCase() },
            });
        }

        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }

        // Create recalculation request (DRAFT status)
        const request = await prisma.recalculationRequest.create({
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

        await createAuditLog({
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
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Recalculation Request]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/recalculation/:id/submit — Submit for approval
router.put("/:id/submit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.userId!;

        const request = await prisma.recalculationRequest.findFirst({
            where: { id: req.params.id, tenantId, status: "DRAFT" },
        });

        if (!request) {
            res.status(404).json({ success: false, message: "Request not found or already submitted" });
            return;
        }

        // Update status to PENDING_APPROVAL
        await prisma.recalculationRequest.update({
            where: { id: request.id },
            data: {
                status: "PENDING_APPROVAL",
                submittedAt: new Date(),
            },
        });

        await createAuditLog({
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
    } catch (err) {
        console.error("[Recalculation Submit]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/recalculation/:id/approve — Approve and execute (Checker)
router.put("/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.userId!;

        const request = await prisma.recalculationRequest.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });

        if (!request) {
            res.status(404).json({ success: false, message: "Request not found or not pending approval" });
            return;
        }

        // Execute recalculation
        const result = await recalculateInterest({
            tenantId,
            accountId: request.accountId,
            accountType: request.accountType as "SB" | "FDR" | "RD",
            effectiveFromDate: request.effectiveFromDate,
            reason: request.reason,
            requestedBy: request.requestedBy,
        });

        if (!result.success) {
            // Update request status to REJECTED
            await prisma.recalculationRequest.update({
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
        await prisma.recalculationRequest.update({
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

        await createAuditLog({
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
    } catch (err) {
        console.error("[Recalculation Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/recalculation/:id/reject — Reject request (Checker)
router.put("/:id/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.userId!;

        const { rejectionReason } = z.object({
            rejectionReason: z.string().min(10, "Rejection reason must be at least 10 characters"),
        }).parse(req.body);

        const request = await prisma.recalculationRequest.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });

        if (!request) {
            res.status(404).json({ success: false, message: "Request not found or not pending approval" });
            return;
        }

        await prisma.recalculationRequest.update({
            where: { id: request.id },
            data: {
                status: "REJECTED",
                rejectedAt: new Date(),
                rejectedBy: userId,
                rejectionReason,
            },
        });

        await createAuditLog({
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
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Recalculation Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/recalculation/pending — Get pending requests
router.get("/pending", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;

        const requests = await prisma.recalculationRequest.findMany({
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
    } catch (err) {
        console.error("[Recalculation Pending]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
