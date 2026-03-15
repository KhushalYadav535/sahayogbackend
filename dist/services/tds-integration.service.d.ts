/**
 * TDS Integration Service (BRD v4.0 INT-009)
 * Atomic TDS check within interest posting transaction
 */
export interface TDSResult {
    tdsApplicable: boolean;
    tdsAmount: number;
    netCreditAmount: number;
    cumulativeInterestThisFY: number;
    thresholdExceeded: boolean;
}
/**
 * Check TDS applicability and calculate TDS amount (INT-009)
 * Called atomically within interest posting transaction
 */
export declare function checkTDS(tenantId: string, memberId: string, interestBeingPosted: number, financialYear: string): Promise<TDSResult>;
/**
 * Post interest with TDS integration (atomic transaction) - INT-009
 * TDS check is atomic within posting transaction boundary
 */
export declare function postInterestWithTDS(tenantId: string, accountId: string, accountType: "SB" | "FDR" | "RD", memberId: string, interestAmount: number, financialYear: string): Promise<{
    success: boolean;
    netCreditAmount: number;
    tdsAmount: number;
    tdsApplicable: boolean;
    error?: string;
}>;
//# sourceMappingURL=tds-integration.service.d.ts.map