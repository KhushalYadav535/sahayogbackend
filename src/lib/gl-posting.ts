/**
 * Sahayog AI — GL Auto-Posting Engine
 * Maps business transaction types → debit/credit GL entries
 * All postings follow double-entry accounting (∑Debit = ∑Credit per voucher)
 */

import prisma from "../db/prisma";
import { COA_MAP } from "./coa-constants";

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export type GlTransactionType =
    | "SB_DEPOSIT"
    | "SB_WITHDRAWAL"
    | "SB_INTEREST_ACCRUAL"
    | "FDR_OPEN"
    | "FDR_INTEREST_ACCRUAL"
    | "FDR_TDS_DEDUCTED"
    | "FDR_MATURE"
    | "RD_OPEN"
    | "RD_INSTALLMENT"
    | "RD_INSTALLMENT_COLLECTED"
    | "RD_INTEREST_ACCRUAL"
    | "MIS_OPEN"
    | "MIS_INTEREST_PAYOUT"
    | "LOAN_DISBURSEMENT"
    | "LOAN_REPAYMENT_PRINCIPAL"
    | "LOAN_REPAYMENT_INTEREST"
    | "PENAL_INTEREST"
    | "LOAN_PRECLOSURE"
    | "NPA_PROVISION"
    | "NPA_PROVISION_REVERSAL"
    | "INTEREST_SUSPENSE"
    | "WRITE_OFF"
    | "RECOVERY_WRITTEN_OFF"
    | "KCC_SUBVENTION"
    | "STATUTORY_RESERVE"
    | "NCCT_FUND"
    | "DEPRECIATION"
    | "ASSET_DISPOSAL_PROFIT"
    | "ASSET_DISPOSAL_LOSS"
    | "DIVIDEND_PAID"
    | "EXTERNAL_REFINANCE";

interface GlPostingLine {
    glCode: string;
    debit: number;
    credit: number;
}

interface GlPostingMatrix {
    lines: (amount: number, meta?: Record<string, string>) => GlPostingLine[];
}

// ──────────────────────────────────────────────────────────
// Posting Matrix
// ──────────────────────────────────────────────────────────

const POSTING_MATRIX: Record<GlTransactionType, GlPostingMatrix> = {
    SB_DEPOSIT: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },   // DR Cash
            { glCode: "02-01-0001", debit: 0, credit: amount },   // CR SB Members
        ],
    },
    SB_WITHDRAWAL: {
        lines: (amount) => [
            { glCode: "02-01-0001", debit: amount, credit: 0 },   // DR SB Members
            { glCode: "05-01-0001", debit: 0, credit: amount },   // CR Cash
        ],
    },
    SB_INTEREST_ACCRUAL: {
        lines: (amount) => [
            { glCode: "12-01-0001", debit: amount, credit: 0 },   // DR Interest on SB (Expense)
            { glCode: "02-01-0004", debit: 0, credit: amount },   // CR SB Interest Accrued
        ],
    },
    FDR_OPEN: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },   // DR Cash
            { glCode: "02-02-0001", debit: 0, credit: amount },   // CR FD Members
        ],
    },
    FDR_INTEREST_ACCRUAL: {
        lines: (amount) => [
            { glCode: "12-01-0002", debit: amount, credit: 0 },   // DR Interest on FDs (Expense)
            { glCode: "02-02-0004", debit: 0, credit: amount },   // CR FDR Interest Accrued
        ],
    },
    FDR_TDS_DEDUCTED: {
        lines: (amount) => [
            { glCode: "02-02-0004", debit: amount, credit: 0 },   // DR FDR Interest Accrued
            { glCode: "04-01-0001", debit: 0, credit: amount },   // CR TDS Provision 194A
        ],
    },
    FDR_MATURE: {
        lines: (amount) => [
            { glCode: "02-02-0001", debit: amount, credit: 0 },   // DR FD Liability
            { glCode: "05-01-0001", debit: 0, credit: amount },   // CR Cash (payout)
        ],
    },
    RD_INSTALLMENT_COLLECTED: {
        lines: (amount) => [
            { glCode: "02-01-0001", debit: amount, credit: 0 },   // DR SB Members
            { glCode: "02-03-0001", debit: 0, credit: amount },   // CR RD Members
        ],
    },
    RD_INTEREST_ACCRUAL: {
        lines: (amount) => [
            { glCode: "12-01-0003", debit: amount, credit: 0 },   // DR Interest on RD (Expense)
            { glCode: "02-03-0004", debit: 0, credit: amount },   // CR RD Interest Accrued
        ],
    },
    RD_OPEN: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },
            { glCode: "02-02-0003", debit: 0, credit: amount },   // CR Recurring Deposits
        ],
    },
    RD_INSTALLMENT: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },
            { glCode: "02-02-0003", debit: 0, credit: amount },
        ],
    },
    MIS_OPEN: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },
            { glCode: "02-04-0001", debit: 0, credit: amount },   // CR MIS Principal
        ],
    },
    MIS_INTEREST_PAYOUT: {
        lines: (amount) => [
            { glCode: "12-01-0004", debit: amount, credit: 0 },   // DR Interest on MIS (Expense)
            { glCode: "02-01-0001", debit: 0, credit: amount },   // CR SB Account (payout)
        ],
    },
    LOAN_DISBURSEMENT: {
        lines: (amount, meta) => [
            { glCode: meta?.loanGlCode || "07-05-0003", debit: amount, credit: 0 }, // DR Loan GL
            { glCode: "05-01-0001", debit: 0, credit: amount },   // CR Cash
        ],
    },
    LOAN_REPAYMENT_PRINCIPAL: {
        lines: (amount, meta) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },   // DR Cash
            { glCode: meta?.loanGlCode || "07-05-0003", debit: 0, credit: amount }, // CR Loan
        ],
    },
    LOAN_REPAYMENT_INTEREST: {
        lines: (amount, meta) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },
            { glCode: meta?.incomeGlCode || "10-01-0006", debit: 0, credit: amount }, // CR Interest Income
        ],
    },
    PENAL_INTEREST: {
        lines: (amount) => [
            { glCode: "07-05-0005", debit: amount, credit: 0 },   // DR Penal Interest Receivable
            { glCode: "10-01-0007", debit: 0, credit: amount },   // CR Penal Interest Income
        ],
    },
    LOAN_PRECLOSURE: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },
            { glCode: "10-03-0004", debit: 0, credit: amount },   // CR Pre-closure Charges
        ],
    },
    NPA_PROVISION: {
        lines: (amount, meta) => [
            { glCode: "13-03-0001", debit: amount, credit: 0 },   // DR NPA Provision Charge (Expense)
            { glCode: meta?.provisionGlCode || "04-02-0002", debit: 0, credit: amount }, // CR NPA Provision
        ],
    },
    NPA_PROVISION_REVERSAL: {
        lines: (amount, meta) => [
            { glCode: meta?.provisionGlCode || "04-02-0002", debit: amount, credit: 0 }, // DR NPA Provision
            { glCode: "13-03-0002", debit: 0, credit: amount },   // CR Provision Write-back
        ],
    },
    INTEREST_SUSPENSE: {
        lines: (amount) => [
            { glCode: "07-05-0006", debit: amount, credit: 0 },   // DR NPA Interest Suspense
            { glCode: "04-02-0006", debit: 0, credit: amount },   // CR Provision — Loss (suspense offset)
        ],
    },
    WRITE_OFF: {
        lines: (amount, meta) => [
            { glCode: meta?.provisionGlCode || "04-02-0006", debit: amount, credit: 0 }, // DR NPA Provision
            { glCode: meta?.loanGlCode || "07-05-0004", debit: 0, credit: amount },     // CR Written-off Loans
        ],
    },
    RECOVERY_WRITTEN_OFF: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },   // DR Cash
            { glCode: "11-01-0001", debit: 0, credit: amount },   // CR Recovery from Written-off Loans
        ],
    },
    KCC_SUBVENTION: {
        lines: (amount) => [
            { glCode: "09-07-0001", debit: amount, credit: 0 },   // DR Subvention Receivable
            { glCode: "10-02-0004", debit: 0, credit: amount },   // CR Subvention Income
        ],
    },
    STATUTORY_RESERVE: {
        lines: (amount) => [
            { glCode: "13-02-0002", debit: amount, credit: 0 },   // DR Transfer to Statutory Reserve
            { glCode: "01-02-0001", debit: 0, credit: amount },   // CR Statutory Reserve
        ],
    },
    NCCT_FUND: {
        lines: (amount) => [
            { glCode: "13-02-0004", debit: amount, credit: 0 },   // DR Transfer to NCCT Fund
            { glCode: "01-02-0006", debit: 0, credit: amount },   // CR NCCT Fund
        ],
    },
    DEPRECIATION: {
        lines: (amount, meta) => [
            { glCode: "13-02-0007", debit: amount, credit: 0 },   // DR Depreciation Expense
            { glCode: meta?.accumGlCode || "08-03-0002", debit: 0, credit: amount }, // CR Accumulated Depr.
        ],
    },
    ASSET_DISPOSAL_PROFIT: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },   // DR Cash (sale proceeds)
            { glCode: "11-01-0002", debit: 0, credit: amount },   // CR Profit on Disposal
        ],
    },
    ASSET_DISPOSAL_LOSS: {
        lines: (amount) => [
            { glCode: "13-02-0005", debit: amount, credit: 0 },   // DR Loss on Disposal
            { glCode: "05-01-0001", debit: 0, credit: amount },   // CR Cash (net of loss)
        ],
    },
    DIVIDEND_PAID: {
        lines: (amount) => [
            { glCode: "03-03-0001", debit: amount, credit: 0 },   // DR Dividend Payable
            { glCode: "02-01-0001", debit: 0, credit: amount },   // CR SB Members
        ],
    },
    EXTERNAL_REFINANCE: {
        lines: (amount) => [
            { glCode: "05-01-0001", debit: amount, credit: 0 },   // DR Cash (refinance receipt)
            { glCode: "02-05-0003", debit: 0, credit: amount },   // CR Refinance Borrowings
        ],
    },
};

// ──────────────────────────────────────────────────────────
// GL Posting Engine
// ──────────────────────────────────────────────────────────

/**
 * Post GL entries for a transaction type.
 * Creates a JV voucher and associated GlEntry records.
 */
export async function postGl(
    tenantId: string,
    txType: GlTransactionType,
    amount: number,
    narration: string,
    period: string,            // "YYYY-MM"
    meta?: Record<string, string>
): Promise<void> {
    if (amount <= 0) return;

    const matrix = POSTING_MATRIX[txType];
    if (!matrix) {
        console.warn(`[GL] No posting matrix for type: ${txType}`);
        return;
    }

    const lines = matrix.lines(amount, meta);

    // Resolve GL names from COA_MAP (fallback to code)
    const glEntries = lines.map((line) => ({
        tenantId,
        glCode: line.glCode,
        glName: COA_MAP.get(line.glCode)?.name ?? line.glCode,
        debit: line.debit,
        credit: line.credit,
        narration,
        postingDate: new Date(),
        period,
    }));

    // DA-001: Generate voucher number - VCH-YYYY-MM-NNNNNN format
    const count = await prisma.voucher.count({ where: { tenantId } });
    const { generateVoucherId } = await import("./id-generator");
    const now = new Date();
    const voucherNumber = generateVoucherId(count + 1, now.getFullYear(), now.getMonth() + 1).replace("VCH", "JV");

    await prisma.$transaction(async (tx) => {
        const voucher = await tx.voucher.create({
            data: {
                tenantId,
                voucherNumber,
                voucherType: "JV",
                date: new Date(),
                narration,
                totalAmount: amount,
                status: "posted",
            },
        });

        await tx.glEntry.createMany({
            data: glEntries.map((e) => ({ ...e, voucherId: voucher.id })),
        });
    });
}

/**
 * Helper to get current period string "YYYY-MM"
 */
export function currentPeriod(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Alias for backward compat with existing loans.ts references
 */
export async function postGlFromMatrix(
    tenantId: string,
    txType: GlTransactionType,
    amount: number,
    narration: string,
    period: string,
    meta?: Record<string, string>
): Promise<void> {
    return postGl(tenantId, txType, amount, narration, period, meta);
}
