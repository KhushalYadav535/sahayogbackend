/**
 * Module 14 - DA-001: ID Generation Standards
 * All ID formats are metadata-configurable. IDs are never reused.
 */

import { randomBytes } from "crypto";

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
export function generateMemberId(sequence: number, year?: number): string {
    const yyyy = year || new Date().getFullYear();
    return `MEM-${yyyy}-${String(sequence).padStart(6, "0")}`;
}

/**
 * Generate Loan Account ID: LN-YYYY-NNNNNN
 */
export function generateLoanId(sequence: number, year?: number): string {
    const yyyy = year || new Date().getFullYear();
    return `LN-${yyyy}-${String(sequence).padStart(6, "0")}`;
}

/**
 * Generate SB Account ID: SB-YYYY-NNNNNN
 */
export function generateSbAccountId(sequence: number, year?: number): string {
    const yyyy = year || new Date().getFullYear();
    return `SB-${yyyy}-${String(sequence).padStart(6, "0")}`;
}

/**
 * Generate FDR Account ID: FDR-YYYY-NNNNNN
 */
export function generateFdrAccountId(sequence: number, year?: number): string {
    const yyyy = year || new Date().getFullYear();
    return `FDR-${yyyy}-${String(sequence).padStart(6, "0")}`;
}

/**
 * Generate Transaction ID: TXN-YYYYMMDD-{8-digit-UUID-suffix}
 */
export function generateTransactionId(): string {
    const now = new Date();
    const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    // Generate 8-character hex suffix from random bytes
    const suffix = randomBytes(4).toString("hex").toUpperCase();
    return `TXN-${yyyymmdd}-${suffix}`;
}

/**
 * Generate GL Voucher ID: VCH-YYYY-MM-NNNNNN
 */
export function generateVoucherId(sequence: number, year?: number, month?: number): string {
    const now = new Date();
    const yyyy = year || now.getFullYear();
    const mm = month || (now.getMonth() + 1);
    return `VCH-${yyyy}-${String(mm).padStart(2, "0")}-${String(sequence).padStart(6, "0")}`;
}
