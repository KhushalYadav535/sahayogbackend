/**
 * Sahayog AI — GL Auto-Posting Engine
 * Maps business transaction types → debit/credit GL entries
 * All postings follow double-entry accounting (∑Debit = ∑Credit per voucher)
 */
export type GlTransactionType = "SB_DEPOSIT" | "SB_WITHDRAWAL" | "SB_INTEREST_ACCRUAL" | "FDR_OPEN" | "FDR_INTEREST_ACCRUAL" | "FDR_TDS_DEDUCTED" | "FDR_MATURE" | "RD_OPEN" | "RD_INSTALLMENT" | "MIS_OPEN" | "MIS_INTEREST_PAYOUT" | "LOAN_DISBURSEMENT" | "LOAN_REPAYMENT_PRINCIPAL" | "LOAN_REPAYMENT_INTEREST" | "PENAL_INTEREST" | "LOAN_PRECLOSURE" | "NPA_PROVISION" | "NPA_PROVISION_REVERSAL" | "INTEREST_SUSPENSE" | "WRITE_OFF" | "RECOVERY_WRITTEN_OFF" | "KCC_SUBVENTION" | "STATUTORY_RESERVE" | "NCCT_FUND" | "DEPRECIATION" | "ASSET_DISPOSAL_PROFIT" | "ASSET_DISPOSAL_LOSS";
/**
 * Post GL entries for a transaction type.
 * Creates a JV voucher and associated GlEntry records.
 */
export declare function postGl(tenantId: string, txType: GlTransactionType, amount: number, narration: string, period: string, // "YYYY-MM"
meta?: Record<string, string>): Promise<void>;
/**
 * Helper to get current period string "YYYY-MM"
 */
export declare function currentPeriod(): string;
/**
 * Alias for backward compat with existing loans.ts references
 */
export declare function postGlFromMatrix(tenantId: string, txType: GlTransactionType, amount: number, narration: string, period: string, meta?: Record<string, string>): Promise<void>;
//# sourceMappingURL=gl-posting.d.ts.map