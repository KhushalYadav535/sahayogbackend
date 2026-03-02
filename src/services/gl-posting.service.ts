/**
 * ACC-002 — Auto GL Posting Matrix
 * All system-generated transactions post via metadata-driven mapping.
 */
import prisma from "../db/prisma";

export type GlPostingType =
    | "LOAN_DISBURSEMENT"
    | "EMI_RECEIPT"
    | "FDR_CREATION"
    | "FDR_INTEREST_ACCRUAL"
    | "TDS_DEDUCTION"
    | "SB_INTEREST_CREDIT"
    | "SB_DEPOSIT"
    | "SB_WITHDRAWAL"
    | "SB_TRANSFER"
    | "DIVIDEND_PAYMENT"
    | "PROVISION_ENTRY";

export interface GlMatrixEntry {
    DR: string;
    CR: string;
}

const DEFAULT_MATRIX: Record<string, GlMatrixEntry> = {
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

export async function getGlMatrix(tenantId: string): Promise<Record<string, GlMatrixEntry>> {
    const config = await prisma.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key: "gl.auto.posting.matrix" } },
    });
    if (config?.value) {
        try {
            return { ...DEFAULT_MATRIX, ...JSON.parse(config.value) };
        } catch {
            return DEFAULT_MATRIX;
        }
    }
    return DEFAULT_MATRIX;
}

export async function postGlFromMatrix(
    tenantId: string,
    postingType: GlPostingType,
    amount: number,
    narration: string,
    period: string,
    voucherId?: string
): Promise<void> {
    const matrix = await getGlMatrix(tenantId);
    const entry = matrix[postingType];
    if (!entry) throw new Error(`No GL matrix entry for ${postingType}`);

    const postingDate = new Date();

    await prisma.glEntry.createMany({
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
