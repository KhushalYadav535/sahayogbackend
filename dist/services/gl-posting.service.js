"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGlMatrix = getGlMatrix;
exports.postGlFromMatrix = postGlFromMatrix;
/**
 * ACC-002 — Auto GL Posting Matrix
 * All system-generated transactions post via metadata-driven mapping.
 */
const prisma_1 = __importDefault(require("../db/prisma"));
const DEFAULT_MATRIX = {
    LOAN_DISBURSEMENT: { DR: "Loans & Advances", CR: "Savings Bank Deposits" },
    EMI_RECEIPT: { DR: "Savings Bank Deposits", CR: "Loan Repayment Suspense" },
    FDR_CREATION: { DR: "Cash/SB", CR: "Fixed Deposits" },
    FDR_INTEREST_ACCRUAL: { DR: "Interest Accrued Receivable", CR: "Interest Income on FDR" },
    TDS_DEDUCTION: { DR: "Interest Income on FDR", CR: "TDS Payable" },
    SB_INTEREST_CREDIT: { DR: "Interest on SB", CR: "Savings Bank Deposits" },
    SB_DEPOSIT: { DR: "Cash", CR: "Savings Bank Deposits" },
    SB_WITHDRAWAL: { DR: "Savings Bank Deposits", CR: "Cash" },
    SB_TRANSFER: { DR: "Savings Bank Deposits", CR: "Savings Bank Deposits" },
    DIVIDEND_PAYMENT: { DR: "Dividend Payable", CR: "Savings Bank Deposits" },
    PROVISION_ENTRY: { DR: "Provision for Bad Debts", CR: "Loan Loss Provision" },
};
async function getGlMatrix(tenantId) {
    const config = await prisma_1.default.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key: "gl.auto.posting.matrix" } },
    });
    if (config?.value) {
        try {
            return { ...DEFAULT_MATRIX, ...JSON.parse(config.value) };
        }
        catch {
            return DEFAULT_MATRIX;
        }
    }
    return DEFAULT_MATRIX;
}
async function postGlFromMatrix(tenantId, postingType, amount, narration, period, voucherId) {
    const matrix = await getGlMatrix(tenantId);
    const entry = matrix[postingType];
    if (!entry)
        throw new Error(`No GL matrix entry for ${postingType}`);
    const postingDate = new Date();
    await prisma_1.default.glEntry.createMany({
        data: [
            {
                tenantId,
                voucherId,
                glCode: entry.DR.replace(/\s/g, "_").substring(0, 20),
                glName: entry.DR,
                debit: amount,
                credit: 0,
                narration,
                postingDate,
                period,
            },
            {
                tenantId,
                voucherId,
                glCode: entry.CR.replace(/\s/g, "_").substring(0, 20),
                glName: entry.CR,
                debit: 0,
                credit: amount,
                narration,
                postingDate,
                period,
            },
        ],
    });
}
//# sourceMappingURL=gl-posting.service.js.map