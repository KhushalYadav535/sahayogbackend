"use strict";
/**
 * Module 14 - DA-001: ID Generation Standards
 * All ID formats are metadata-configurable. IDs are never reused.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateMemberId = generateMemberId;
exports.generateLoanId = generateLoanId;
exports.generateSbAccountId = generateSbAccountId;
exports.generateFdrAccountId = generateFdrAccountId;
exports.generateTransactionId = generateTransactionId;
exports.generateVoucherId = generateVoucherId;
const crypto_1 = require("crypto");
/**
 * Generate Member ID: MEM-YYYY-NNNNNN
 */
function generateMemberId(sequence, year) {
    const yyyy = year || new Date().getFullYear();
    return `MEM-${yyyy}-${String(sequence).padStart(6, "0")}`;
}
/**
 * Generate Loan Account ID: LN-YYYY-NNNNNN
 */
function generateLoanId(sequence, year) {
    const yyyy = year || new Date().getFullYear();
    return `LN-${yyyy}-${String(sequence).padStart(6, "0")}`;
}
/**
 * Generate SB Account ID: SB-YYYY-NNNNNN
 */
function generateSbAccountId(sequence, year) {
    const yyyy = year || new Date().getFullYear();
    return `SB-${yyyy}-${String(sequence).padStart(6, "0")}`;
}
/**
 * Generate FDR Account ID: FDR-YYYY-NNNNNN
 */
function generateFdrAccountId(sequence, year) {
    const yyyy = year || new Date().getFullYear();
    return `FDR-${yyyy}-${String(sequence).padStart(6, "0")}`;
}
/**
 * Generate Transaction ID: TXN-YYYYMMDD-{8-digit-UUID-suffix}
 */
function generateTransactionId() {
    const now = new Date();
    const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    // Generate 8-character hex suffix from random bytes
    const suffix = (0, crypto_1.randomBytes)(4).toString("hex").toUpperCase();
    return `TXN-${yyyymmdd}-${suffix}`;
}
/**
 * Generate GL Voucher ID: VCH-YYYY-MM-NNNNNN
 */
function generateVoucherId(sequence, year, month) {
    const now = new Date();
    const yyyy = year || now.getFullYear();
    const mm = month || (now.getMonth() + 1);
    return `VCH-${yyyy}-${String(mm).padStart(2, "0")}-${String(sequence).padStart(6, "0")}`;
}
//# sourceMappingURL=id-generator.js.map