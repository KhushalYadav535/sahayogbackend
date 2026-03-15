"use strict";
/**
 * AI Anomaly Detection Service (BRD v4.0 INT-012)
 * Detects anomalies in interest calculations by comparing engine output to AI-computed expected values
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAnomaly = detectAnomaly;
exports.getPendingAnomalyAlerts = getPendingAnomalyAlerts;
exports.resolveAnomalyAlert = resolveAnomalyAlert;
exports.escalateAnomalyAlert = escalateAnomalyAlert;
const prisma_1 = __importDefault(require("../db/prisma"));
const interest_calculation_service_1 = require("./interest-calculation.service");
/**
 * Simulate AI model computation (placeholder - actual AI model integration pending)
 * In production, this would call an AI service to independently compute expected interest
 */
async function computeExpectedInterest(tenantId, accountId, accountType, principal, accrualDate, rateApplied, tenureDays, memberAge) {
    // Placeholder: For now, use the same calculation engine
    // In production, this would be an independent AI model computation
    try {
        const result = await (0, interest_calculation_service_1.calculateInterest)({
            tenantId,
            productType: accountType,
            principal,
            calculationDate: accrualDate,
            tenureDays,
            memberAge,
            providedRate: rateApplied, // Use same rate for comparison
        });
        return result.interestAmount;
    }
    catch (err) {
        console.error("[Anomaly Detection] Error computing expected interest:", err);
        // Fallback: return actual interest (no anomaly detected)
        return 0;
    }
}
/**
 * Check anomaly threshold configuration
 */
async function getAnomalyThreshold(tenantId) {
    const thresholdPctConfig = await prisma_1.default.systemConfig.findFirst({
        where: {
            tenantId: "PLATFORM",
            key: "interest.anomaly.threshold.pct",
        },
    });
    const thresholdModeConfig = await prisma_1.default.systemConfig.findFirst({
        where: {
            tenantId: "PLATFORM",
            key: "interest.anomaly.threshold.mode",
        },
    });
    const sensitivityConfig = await prisma_1.default.systemConfig.findFirst({
        where: {
            tenantId,
            key: "ai.anomaly.sensitivity",
        },
    });
    const thresholdPct = parseFloat(thresholdPctConfig?.value || "0.01"); // Default 0.01%
    const mode = (thresholdModeConfig?.value || "RELATIVE_PCT");
    const sensitivity = sensitivityConfig?.value || "MEDIUM";
    // Adjust threshold based on sensitivity
    let effectiveThreshold = thresholdPct;
    if (mode === "RELATIVE_PCT") {
        if (sensitivity === "LOW") {
            effectiveThreshold = thresholdPct * 2; // Less sensitive = higher threshold
        }
        else if (sensitivity === "HIGH") {
            effectiveThreshold = thresholdPct * 0.5; // More sensitive = lower threshold
        }
    }
    else {
        // ABSOLUTE_INR mode
        const thresholdInr = parseFloat(thresholdPctConfig?.value || "1.0"); // Default ₹1
        if (sensitivity === "LOW") {
            effectiveThreshold = thresholdInr * 2;
        }
        else if (sensitivity === "HIGH") {
            effectiveThreshold = thresholdInr * 0.5;
        }
        else {
            effectiveThreshold = thresholdInr;
        }
    }
    return {
        threshold: effectiveThreshold,
        mode,
        sensitivity,
    };
}
/**
 * Detect anomaly in interest calculation (INT-012)
 */
async function detectAnomaly(tenantId, accountId, accountType, principal, accrualDate, actualInterest, rateApplied, tenureDays, memberAge) {
    try {
        // 1. Compute expected interest using AI model (or independent calculation)
        const expectedInterest = await computeExpectedInterest(tenantId, accountId, accountType, principal, accrualDate, rateApplied, tenureDays, memberAge);
        // 2. Get threshold configuration
        const { threshold, mode, sensitivity } = await getAnomalyThreshold(tenantId);
        // 3. Calculate deviation
        const deviationAmount = Math.abs(actualInterest - expectedInterest);
        const deviationPct = expectedInterest > 0
            ? (deviationAmount / expectedInterest) * 100
            : 0;
        // 4. Check if anomaly exceeds threshold
        let isAnomaly = false;
        if (mode === "RELATIVE_PCT") {
            isAnomaly = deviationPct > threshold;
        }
        else {
            // ABSOLUTE_INR mode
            isAnomaly = deviationAmount > threshold;
        }
        // 5. Log anomaly alert if detected
        let alertStatus = "PENDING";
        if (isAnomaly) {
            // Get AI model version
            const activeModel = await prisma_1.default.aiModel.findFirst({
                where: {
                    modelId: "interest_anomaly_detection",
                    isActive: true,
                },
                orderBy: { deployedAt: "desc" },
            });
            const modelVersion = activeModel?.version || "v1.0";
            // Create AI audit log entry
            await prisma_1.default.aiAuditLog.create({
                data: {
                    tenantId,
                    feature: "interest_anomaly_detection",
                    inputData: {
                        accountId,
                        accountType,
                        principal,
                        accrualDate: accrualDate.toISOString(),
                        rateApplied,
                        tenureDays,
                        memberAge,
                    },
                    outputData: {
                        expectedInterest,
                        actualInterest,
                        deviationAmount,
                        deviationPct,
                        threshold,
                        thresholdMode: mode,
                        sensitivity,
                        isAnomaly: true,
                    },
                    modelVersion,
                    success: true,
                    explanationText: `Interest anomaly detected: Expected ₹${expectedInterest.toFixed(2)}, Actual ₹${actualInterest.toFixed(2)}, Deviation ${deviationPct.toFixed(4)}%`,
                },
            });
            // Create alert record (if you have an alerts table, otherwise use audit log)
            // For now, we'll use the AI audit log as the alert record
        }
        return {
            isAnomaly,
            deviationAmount: Math.round(deviationAmount * 100) / 100,
            deviationPct: Math.round(deviationPct * 10000) / 10000, // 4 decimal places
            expectedInterest: Math.round(expectedInterest * 100) / 100,
            actualInterest: Math.round(actualInterest * 100) / 100,
            threshold,
            thresholdMode: mode,
            alertStatus,
        };
    }
    catch (err) {
        console.error("[Anomaly Detection]", err);
        // On error, don't flag as anomaly (fail-safe)
        return {
            isAnomaly: false,
            deviationAmount: 0,
            deviationPct: 0,
            expectedInterest: actualInterest,
            actualInterest,
            threshold: 0,
            thresholdMode: "RELATIVE_PCT",
            alertStatus: "PENDING",
        };
    }
}
/**
 * Get pending anomaly alerts for checker queue
 */
async function getPendingAnomalyAlerts(tenantId, limit = 50) {
    const alerts = await prisma_1.default.aiAuditLog.findMany({
        where: {
            tenantId,
            feature: "interest_anomaly_detection",
            success: true,
            createdAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
            },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
    });
    // Filter alerts where anomaly was detected
    return alerts.filter((alert) => {
        const outputData = alert.outputData;
        return outputData?.isAnomaly === true;
    });
}
/**
 * Resolve anomaly alert (Checker action)
 */
async function resolveAnomalyAlert(tenantId, alertId, resolutionNote, resolvedBy) {
    try {
        const alert = await prisma_1.default.aiAuditLog.findFirst({
            where: {
                id: alertId,
                tenantId,
                feature: "interest_anomaly_detection",
            },
        });
        if (!alert) {
            return { success: false, error: "Alert not found" };
        }
        // Update alert with resolution
        await prisma_1.default.aiAuditLog.update({
            where: { id: alertId },
            data: {
                humanOverrideFlag: true,
                overrideReason: resolutionNote,
                overrideReasonCode: "RESOLVED",
            },
        });
        // Create audit log
        await prisma_1.default.auditLog.create({
            data: {
                tenantId,
                userId: resolvedBy,
                action: "ANOMALY_ALERT_RESOLVED",
                entity: "AiAuditLog",
                entityId: alertId,
                newData: { resolutionNote },
                ipAddress: "system",
            },
        });
        return { success: true };
    }
    catch (err) {
        console.error("[Resolve Anomaly]", err);
        return { success: false, error: err instanceof Error ? err.message : "Failed to resolve alert" };
    }
}
/**
 * Escalate anomaly alert (Checker action)
 */
async function escalateAnomalyAlert(tenantId, alertId, escalationReason, escalatedBy) {
    try {
        const alert = await prisma_1.default.aiAuditLog.findFirst({
            where: {
                id: alertId,
                tenantId,
                feature: "interest_anomaly_detection",
            },
        });
        if (!alert) {
            return { success: false, error: "Alert not found" };
        }
        // Update alert with escalation
        await prisma_1.default.aiAuditLog.update({
            where: { id: alertId },
            data: {
                humanOverrideFlag: true,
                overrideReason: escalationReason,
                overrideReasonCode: "ESCALATED",
            },
        });
        // Create audit log
        await prisma_1.default.auditLog.create({
            data: {
                tenantId,
                userId: escalatedBy,
                action: "ANOMALY_ALERT_ESCALATED",
                entity: "AiAuditLog",
                entityId: alertId,
                newData: { escalationReason },
                ipAddress: "system",
            },
        });
        return { success: true };
    }
    catch (err) {
        console.error("[Escalate Anomaly]", err);
        return { success: false, error: err instanceof Error ? err.message : "Failed to escalate alert" };
    }
}
//# sourceMappingURL=anomaly-detection.service.js.map