/**
 * Module 14 - DA-001: ID Generation Standards
 * All ID formats are metadata-configurable. IDs are never reused.
 */
export interface IdGenerationConfig {
    memberPrefix?: string;
    loanPrefix?: string;
    sbPrefix?: string;
    fdrPrefix?: string;
    transactionPrefix?: string;
    voucherPrefix?: string;
}
/**
 * Generate Member ID: MEM-YYYY-NNNNNN
 */
export declare function generateMemberId(sequence: number, year?: number): string;
/**
 * Generate Loan Account ID: LN-YYYY-NNNNNN
 */
export declare function generateLoanId(sequence: number, year?: number): string;
/**
 * Generate SB Account ID: SB-YYYY-NNNNNN
 */
export declare function generateSbAccountId(sequence: number, year?: number): string;
/**
 * Generate FDR Account ID: FDR-YYYY-NNNNNN
 */
export declare function generateFdrAccountId(sequence: number, year?: number): string;
/**
 * Generate Transaction ID: TXN-YYYYMMDD-{8-digit-UUID-suffix}
 */
export declare function generateTransactionId(): string;
/**
 * Generate GL Voucher ID: VCH-YYYY-MM-NNNNNN
 */
export declare function generateVoucherId(sequence: number, year?: number, month?: number): string;
//# sourceMappingURL=id-generator.d.ts.map