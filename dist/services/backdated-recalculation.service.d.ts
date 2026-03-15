/**
 * Backdated Interest Recalculation Service (BRD v4.0 INT-010)
 * Handles interest recalculation with concurrency protection and maximum backdate window
 */
export interface RecalculationRequest {
    tenantId: string;
    accountId: string;
    accountType: "SB" | "FDR" | "RD";
    effectiveFromDate: Date;
    reason: string;
    requestedBy: string;
}
export interface RecalculationResult {
    success: boolean;
    reversalCount: number;
    recalculationCount: number;
    netDifference: number;
    error?: string;
}
/**
 * Recalculate interest with concurrency protection (INT-010)
 * Uses optimistic locking via version field or account-level lock
 */
export declare function recalculateInterest(request: RecalculationRequest): Promise<RecalculationResult>;
/**
 * Check if recalculation is already in progress (idempotency check)
 */
export declare function isRecalculationInProgress(tenantId: string, accountId: string, accountType: "SB" | "FDR" | "RD"): Promise<boolean>;
//# sourceMappingURL=backdated-recalculation.service.d.ts.map