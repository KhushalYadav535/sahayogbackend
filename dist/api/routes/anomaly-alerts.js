"use strict";
/**
 * AI Anomaly Alert Management API (BRD v4.0 INT-012)
 * Checker queue for resolving/escalating anomaly alerts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const anomaly_detection_service_1 = require("../../services/anomaly-detection.service");
const router = (0, express_1.Router)();
// GET /api/v1/anomaly-alerts/pending — Get pending alerts for checker queue
router.get("/pending", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const limit = parseInt(req.query.limit) || 50;
        const alerts = await (0, anomaly_detection_service_1.getPendingAnomalyAlerts)(tenantId, limit);
        res.json({
            success: true,
            alerts: alerts.map((alert) => ({
                id: alert.id,
                accountId: alert.inputData?.accountId,
                accountType: alert.inputData?.accountType,
                accrualDate: alert.inputData?.accrualDate,
                expectedInterest: alert.outputData?.expectedInterest,
                actualInterest: alert.outputData?.actualInterest,
                deviationAmount: alert.outputData?.deviationAmount,
                deviationPct: alert.outputData?.deviationPct,
                threshold: alert.outputData?.threshold,
                thresholdMode: alert.outputData?.thresholdMode,
                modelVersion: alert.modelVersion,
                explanationText: alert.explanationText,
                createdAt: alert.createdAt,
            })),
        });
    }
    catch (err) {
        console.error("[Anomaly Alerts Pending]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/anomaly-alerts/:id/resolve — Resolve alert (Checker)
router.put("/:id/resolve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const { resolutionNote } = zod_1.z.object({
            resolutionNote: zod_1.z.string().min(10, "Resolution note must be at least 10 characters"),
        }).parse(req.body);
        const result = await (0, anomaly_detection_service_1.resolveAnomalyAlert)(tenantId, req.params.id, resolutionNote, userId);
        if (!result.success) {
            res.status(400).json({ success: false, message: result.error });
            return;
        }
        res.json({
            success: true,
            message: "Anomaly alert resolved",
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Anomaly Alert Resolve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/anomaly-alerts/:id/escalate — Escalate alert (Checker)
router.put("/:id/escalate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        const { escalationReason } = zod_1.z.object({
            escalationReason: zod_1.z.string().min(10, "Escalation reason must be at least 10 characters"),
        }).parse(req.body);
        const result = await (0, anomaly_detection_service_1.escalateAnomalyAlert)(tenantId, req.params.id, escalationReason, userId);
        if (!result.success) {
            res.status(400).json({ success: false, message: result.error });
            return;
        }
        res.json({
            success: true,
            message: "Anomaly alert escalated to Compliance Officer",
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Anomaly Alert Escalate]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=anomaly-alerts.js.map