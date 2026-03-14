/**
 * AI Anomaly Alert Management API (BRD v4.0 INT-012)
 * Checker queue for resolving/escalating anomaly alerts
 */

import { Router, Response } from "express";
import { z } from "zod";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import {
    getPendingAnomalyAlerts,
    resolveAnomalyAlert,
    escalateAnomalyAlert,
} from "../../services/anomaly-detection.service";
import { createAuditLog } from "../../db/audit";

const router = Router();

// GET /api/v1/anomaly-alerts/pending — Get pending alerts for checker queue
router.get("/pending", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const limit = parseInt(req.query.limit as string) || 50;

        const alerts = await getPendingAnomalyAlerts(tenantId, limit);

        res.json({
            success: true,
            alerts: alerts.map((alert) => ({
                id: alert.id,
                accountId: (alert.inputData as any)?.accountId,
                accountType: (alert.inputData as any)?.accountType,
                accrualDate: (alert.inputData as any)?.accrualDate,
                expectedInterest: (alert.outputData as any)?.expectedInterest,
                actualInterest: (alert.outputData as any)?.actualInterest,
                deviationAmount: (alert.outputData as any)?.deviationAmount,
                deviationPct: (alert.outputData as any)?.deviationPct,
                threshold: (alert.outputData as any)?.threshold,
                thresholdMode: (alert.outputData as any)?.thresholdMode,
                modelVersion: alert.modelVersion,
                explanationText: alert.explanationText,
                createdAt: alert.createdAt,
            })),
        });
    } catch (err) {
        console.error("[Anomaly Alerts Pending]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/anomaly-alerts/:id/resolve — Resolve alert (Checker)
router.put("/:id/resolve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.userId!;

        const { resolutionNote } = z.object({
            resolutionNote: z.string().min(10, "Resolution note must be at least 10 characters"),
        }).parse(req.body);

        const result = await resolveAnomalyAlert(tenantId, req.params.id, resolutionNote, userId);

        if (!result.success) {
            res.status(400).json({ success: false, message: result.error });
            return;
        }

        res.json({
            success: true,
            message: "Anomaly alert resolved",
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Anomaly Alert Resolve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/anomaly-alerts/:id/escalate — Escalate alert (Checker)
router.put("/:id/escalate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.userId!;

        const { escalationReason } = z.object({
            escalationReason: z.string().min(10, "Escalation reason must be at least 10 characters"),
        }).parse(req.body);

        const result = await escalateAnomalyAlert(tenantId, req.params.id, escalationReason, userId);

        if (!result.success) {
            res.status(400).json({ success: false, message: result.error });
            return;
        }

        res.json({
            success: true,
            message: "Anomaly alert escalated to Compliance Officer",
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Anomaly Alert Escalate]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
