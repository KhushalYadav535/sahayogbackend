"use strict";
/**
 * Interest Posting Engine (BRD v4.0 INT-009)
 * Periodic interest posting with atomic TDS integration
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const gl_posting_1 = require("../../lib/gl-posting");
const tds_integration_service_1 = require("../../services/tds-integration.service");
const audit_1 = require("../../db/audit");
const router = (0, express_1.Router)();
/**
 * Get current financial year (April to March)
 */
function getCurrentFinancialYear() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-12
    if (month >= 4) {
        // April to December: FY is year-year+1
        return `${year}-${String(year + 1).slice(-2)}`;
    }
    else {
        // January to March: FY is year-1-year
        return `${year - 1}-${String(year).slice(-2)}`;
    }
}
// POST /api/v1/interest/post/sb — Post SB interest (Quarterly/Half-yearly)
router.post("/post/sb", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { postingDate, accountIds } = zod_1.z.object({
            postingDate: zod_1.z.string().optional().transform((s) => s ? new Date(s) : new Date()),
            accountIds: zod_1.z.array(zod_1.z.string()).optional(),
        }).parse(req.body);
        const period = (0, gl_posting_1.currentPeriod)();
        const postingDateObj = postingDate || new Date();
        // Get unposted SB accruals
        const whereClause = {
            tenantId,
            accountType: "SB",
            posted: false,
            accrualDate: { lte: postingDateObj },
        };
        if (accountIds && accountIds.length > 0) {
            whereClause.accountId = { in: accountIds };
        }
        const accruals = await prisma_1.default.interestAccrual.findMany({
            where: whereClause,
            include: {
            // Get account details
            },
        });
        // Group by account
        const accountGroups = new Map();
        for (const accrual of accruals) {
            if (!accountGroups.has(accrual.accountId)) {
                accountGroups.set(accrual.accountId, []);
            }
            accountGroups.get(accrual.accountId).push(accrual);
        }
        let postedCount = 0;
        let totalInterestPosted = 0;
        const errors = [];
        for (const [accountId, accountAccruals] of accountGroups) {
            try {
                const totalInterest = accountAccruals.reduce((sum, acc) => sum + Number(acc.amountAccrued), 0);
                // Get SB account
                const sbAccount = await prisma_1.default.sbAccount.findUnique({
                    where: { id: accountId },
                    include: { member: true },
                });
                if (!sbAccount) {
                    errors.push({ accountId, error: "SB account not found" });
                    continue;
                }
                // Post interest (SB interest doesn't have TDS)
                const newBalance = Number(sbAccount.balance) + totalInterest;
                await prisma_1.default.$transaction(async (tx) => {
                    // Update account balance
                    await tx.sbAccount.update({
                        where: { id: accountId },
                        data: {
                            balance: newBalance,
                            lastActivityAt: postingDateObj,
                        },
                    });
                    // Create transaction record
                    await tx.transaction.create({
                        data: {
                            accountId,
                            type: "credit",
                            category: "interest",
                            amount: totalInterest,
                            balanceAfter: newBalance,
                            remarks: `Interest credit — ${sbAccount.accountNumber}`,
                        },
                    });
                    // Mark accruals as posted
                    await tx.interestAccrual.updateMany({
                        where: {
                            id: { in: accountAccruals.map((a) => a.id) },
                        },
                        data: {
                            posted: true,
                            postedAt: postingDateObj,
                        },
                    });
                });
                // GL posting
                await (0, gl_posting_1.postGl)(tenantId, "SB_INTEREST_ACCRUAL", totalInterest, `SB interest credit — ${sbAccount.accountNumber}`, period);
                postedCount++;
                totalInterestPosted += totalInterest;
            }
            catch (err) {
                errors.push({
                    accountId,
                    error: err instanceof Error ? err.message : "Posting failed",
                });
            }
        }
        await (0, audit_1.createAuditLog)(tenantId, "SB_INTEREST_POSTED", {
            postingDate: postingDateObj.toISOString(),
            accountsPosted: postedCount,
            totalInterestPosted,
            errors: errors.length,
        });
        res.json({
            success: true,
            message: `Posted interest to ${postedCount} SB accounts`,
            postedCount,
            totalInterestPosted,
            errors,
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[SB Interest Posting]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/interest/post/fdr — Post FDR interest with TDS (INT-009)
router.post("/post/fdr", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { postingDate, depositIds } = zod_1.z.object({
            postingDate: zod_1.z.string().optional().transform((s) => s ? new Date(s) : new Date()),
            depositIds: zod_1.z.array(zod_1.z.string()).optional(),
        }).parse(req.body);
        const period = (0, gl_posting_1.currentPeriod)();
        const postingDateObj = postingDate || new Date();
        const financialYear = getCurrentFinancialYear();
        // Get unposted FDR accruals
        const whereClause = {
            tenantId,
            accountType: "FDR",
            posted: false,
            accrualDate: { lte: postingDateObj },
        };
        if (depositIds && depositIds.length > 0) {
            whereClause.accountId = { in: depositIds };
        }
        const accruals = await prisma_1.default.interestAccrual.findMany({
            where: whereClause,
        });
        // Group by deposit
        const depositGroups = new Map();
        for (const accrual of accruals) {
            if (!depositGroups.has(accrual.accountId)) {
                depositGroups.set(accrual.accountId, []);
            }
            depositGroups.get(accrual.accountId).push(accrual);
        }
        let postedCount = 0;
        let totalInterestPosted = 0;
        let totalTDSDeducted = 0;
        const errors = [];
        for (const [depositId, depositAccruals] of depositGroups) {
            try {
                const totalInterest = depositAccruals.reduce((sum, acc) => sum + Number(acc.amountAccrued), 0);
                // Get deposit and member
                const deposit = await prisma_1.default.deposit.findUnique({
                    where: { id: depositId },
                    include: {
                        member: {
                            include: {
                                sbAccounts: { where: { status: "active" }, take: 1 },
                            },
                        },
                    },
                });
                if (!deposit) {
                    errors.push({ depositId, error: "Deposit not found" });
                    continue;
                }
                // INT-009: Atomic TDS check and posting
                const tdsResult = await (0, tds_integration_service_1.postInterestWithTDS)(tenantId, depositId, "FDR", deposit.memberId, totalInterest, financialYear);
                if (!tdsResult.success) {
                    errors.push({
                        depositId,
                        error: tdsResult.error || "TDS check failed",
                    });
                    continue;
                }
                // Credit net interest to SB account (or FDR account based on config)
                const sbAccount = deposit.member.sbAccounts[0];
                if (sbAccount) {
                    const newBalance = Number(sbAccount.balance) + tdsResult.netCreditAmount;
                    await prisma_1.default.$transaction(async (tx) => {
                        // Update SB account balance
                        await tx.sbAccount.update({
                            where: { id: sbAccount.id },
                            data: {
                                balance: newBalance,
                                lastActivityAt: postingDateObj,
                            },
                        });
                        // Create transaction record
                        await tx.transaction.create({
                            data: {
                                accountId: sbAccount.id,
                                type: "credit",
                                category: "interest",
                                amount: tdsResult.netCreditAmount,
                                balanceAfter: newBalance,
                                remarks: `FDR interest credit (net of TDS) — ${deposit.depositNumber}`,
                            },
                        });
                        // Reduce FDR accrued interest
                        await tx.deposit.update({
                            where: { id: depositId },
                            data: {
                                accruedInterest: {
                                    decrement: totalInterest,
                                },
                            },
                        });
                    });
                    // GL Posting: Net interest credit
                    await (0, gl_posting_1.postGl)(tenantId, "FDR_INTEREST_ACCRUAL", tdsResult.netCreditAmount, `FDR interest credit — ${deposit.depositNumber}`, period);
                    // GL Posting: TDS liability (if applicable)
                    if (tdsResult.tdsApplicable && tdsResult.tdsAmount > 0) {
                        await (0, gl_posting_1.postGl)(tenantId, "FDR_TDS_DEDUCTED", tdsResult.tdsAmount, `TDS deduction — ${deposit.depositNumber}`, period);
                        totalTDSDeducted += tdsResult.tdsAmount;
                    }
                }
                else {
                    // No SB account - credit to FDR account directly
                    await prisma_1.default.deposit.update({
                        where: { id: depositId },
                        data: {
                            accruedInterest: {
                                decrement: totalInterest,
                            },
                        },
                    });
                }
                postedCount++;
                totalInterestPosted += totalInterest;
            }
            catch (err) {
                errors.push({
                    depositId,
                    error: err instanceof Error ? err.message : "Posting failed",
                });
            }
        }
        await (0, audit_1.createAuditLog)(tenantId, "FDR_INTEREST_POSTED", {
            postingDate: postingDateObj.toISOString(),
            depositsPosted: postedCount,
            totalInterestPosted,
            totalTDSDeducted,
            errors: errors.length,
        });
        res.json({
            success: true,
            message: `Posted interest to ${postedCount} FDR deposits`,
            postedCount,
            totalInterestPosted,
            totalTDSDeducted,
            errors,
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[FDR Interest Posting]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=interest-posting.js.map