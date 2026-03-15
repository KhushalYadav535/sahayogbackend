/**
 * AI Anomaly Detection Service (BRD v4.0 INT-012)
 * Detects anomalies in interest calculations by comparing engine output to AI-computed expected values
 */
export interface AnomalyDetectionResult {
    isAnomaly: boolean;
    deviationAmount: number;
    deviationPct: number;
    expectedInterest: number;
    actualInterest: number;
    threshold: number;
    thresholdMode: "RELATIVE_PCT" | "ABSOLUTE_INR";
    alertStatus: "PENDING" | "RESOLVED" | "ESCALATED";
}
/**
 * Detect anomaly in interest calculation (INT-012)
 */
export declare function detectAnomaly(tenantId: string, accountId: string, accountType: "SB" | "FDR" | "RD", principal: number, accrualDate: Date, actualInterest: number, rateApplied: number, tenureDays?: number, memberAge?: number): Promise<AnomalyDetectionResult>;
/**
 * Get pending anomaly alerts for checker queue
 */
export declare function getPendingAnomalyAlerts(tenantId: string, limit?: number): Promise<any[]>;
/**
 * Resolve anomaly alert (Checker action)
 */
export declare function resolveAnomalyAlert(tenantId: string, alertId: string, resolutionNote: string, resolvedBy: string): Promise<{
    success: boolean;
    error?: string;
}>;
/**
 * Escalate anomaly alert (Checker action)
 */
export declare function escalateAnomalyAlert(tenantId: string, alertId: string, escalationReason: string, escalatedBy: string): Promise<{
    success: boolean;
    error?: string;
}>;
//# sourceMappingURL=anomaly-detection.service.d.ts.map