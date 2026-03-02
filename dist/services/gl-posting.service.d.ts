export type GlPostingType = "LOAN_DISBURSEMENT" | "EMI_RECEIPT" | "FDR_CREATION" | "FDR_INTEREST_ACCRUAL" | "TDS_DEDUCTION" | "SB_INTEREST_CREDIT" | "SB_DEPOSIT" | "SB_WITHDRAWAL" | "SB_TRANSFER" | "DIVIDEND_PAYMENT" | "PROVISION_ENTRY";
export interface GlMatrixEntry {
    DR: string;
    CR: string;
}
export declare function getGlMatrix(tenantId: string): Promise<Record<string, GlMatrixEntry>>;
export declare function postGlFromMatrix(tenantId: string, postingType: GlPostingType, amount: number, narration: string, period: string, voucherId?: string): Promise<void>;
//# sourceMappingURL=gl-posting.service.d.ts.map