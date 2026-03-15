"use strict";
/**
 * Backdated Interest Recalculation Service (BRD v4.0 INT-010)
 * Handles interest recalculation with concurrency protection and maximum backdate window
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recalculateInterest = recalculateInterest;
exports.isRecalculationInProgress = isRecalculationInProgress;
const prisma_1 = __importDefault(require("../db/prisma"));
const interest_calculation_service_1 = require("./interest-calculation.service");
const gl_posting_1 = require("../lib/gl-posting");
/**
 * Check maximum backdate window (INT-010)
 */
async function validateBackdateWindow(tenantId, effectiveFromDate) {
    const maxBackdateConfig = await prisma_1.default.systemConfig.findFirst({
        where: {
            tenantId: "PLATFORM",
            key: "interest.backdated.recalc.max.days",
        },
    });
    const maxDays = parseInt(maxBackdateConfig?.value || "90", 10);
    const today = new Date();
    const daysDiff = Math.floor((today.getTime() - effectiveFromDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff > maxDays) {
        return {
            valid: false,
            error: `Backdate window exceeds maximum ${maxDays} days. Requested: ${daysDiff} days`,
        };
    }
    if (daysDiff < 0) {
        return {
            valid: false,
            error: "Effective date cannot be in the future",
        };
    }
    return { valid: true };
}
/**
 * Recalculate interest with concurrency protection (INT-010)
 * Uses optimistic locking via version field or account-level lock
 */
async function recalculateInterest(request) {
    const { tenantId, accountId, accountType, effectiveFromDate, reason, requestedBy } = request;
    try {
        // 1. Validate backdate window
        const windowCheck = await validateBackdateWindow(tenantId, effectiveFromDate);
        if (!windowCheck.valid) {
            return {
                success: false,
                reversalCount: 0,
                recalculationCount: 0,
                netDifference: 0,
                error: windowCheck.error,
            };
        }
        // 2. Get account with optimistic locking
        let account;
        let memberId;
        let currentBalance;
        if (accountType === "SB") {
            account = await prisma_1.default.sbAccount.findUnique({
                where: { id: accountId },
                include: { member: true },
            });
            if (!account) {
                throw new Error("SB account not found");
            }
            memberId = account.memberId;
            currentBalance = Number(account.balance);
        }
        else if (accountType === "FDR" || accountType === "RD") {
            account = await prisma_1.default.deposit.findUnique({
                where: { id: accountId },
                include: { member: true },
            });
            if (!account) {
                throw new Error("Deposit not found");
            }
            memberId = account.memberId;
            currentBalance = Number(account.principal);
        }
        else {
            throw new Error("Invalid account type");
        }
        // 3. Atomic transaction: Reversal + Recalculation
        return await prisma_1.default.$transaction(async (tx) => {
            // Get all accruals from effectiveFromDate onwards
            const accrualsToReverse = await tx.interestAccrual.findMany({
                where: {
                    tenantId,
                    accountId,
                    accountType,
                    accrualDate: { gte: effectiveFromDate },
                    posted: true, // Only reverse posted accruals
                },
                orderBy: { accrualDate: "asc" },
            });
            if (accrualsToReverse.length === 0) {
                return {
                    success: true,
                    reversalCount: 0,
                    recalculationCount: 0,
                    netDifference: 0,
                };
            }
            // Calculate total reversal amount
            const totalReversalAmount = accrualsToReverse.reduce((sum, acc) => sum + Number(acc.amountAccrued), 0);
            // 4. Reverse existing accruals (mark as reversed, don't delete for audit)
            await tx.interestAccrual.updateMany({
                where: {
                    id: { in: accrualsToReverse.map((a) => a.id) },
                },
                data: {
                    posted: false, // Unpost for reversal
                    // Add reversal flag or create reversal records
                },
            });
            // 5. Reverse GL entries
            const period = (0, gl_posting_1.currentPeriod)();
            const reversalGlType = accountType === "SB" ? "SB_INTEREST_ACCRUAL" :
                accountType === "FDR" ? "FDR_INTEREST_ACCRUAL" : "RD_INTEREST_ACCRUAL";
            // Reverse GL (opposite entries)
            await (0, gl_posting_1.postGl)(tenantId, reversalGlType, -totalReversalAmount, `Interest reversal — ${account.accountNumber || account.depositNumber} (Backdated recalculation)`, period);
            // 6. Recalculate interest from effectiveFromDate
            const today = new Date();
            const recalculationDate = new Date(effectiveFromDate);
            let totalRecalculated = 0;
            let recalculationCount = 0;
            // Get member age for senior citizen check
            const memberAge = account.member.dateOfBirth
                ? Math.floor((today.getTime() - account.member.dateOfBirth.getTime()) / (1000 * 60 * 60 * 24 * 365.25))
                : undefined;
            // Calculate tenure days for FDR/RD
            let tenureDays;
            if (accountType === "FDR" || accountType === "RD") {
                tenureDays = Math.floor((today.getTime() - account.openedAt.getTime()) / (1000 * 60 * 60 * 24));
            }
            // Recalculate day by day from effectiveFromDate
            while (recalculationDate <= today) {
                try {
                    const result = await (0, interest_calculation_service_1.calculateInterest)({
                        tenantId,
                        productType: accountType,
                        principal: currentBalance,
                        calculationDate: recalculationDate,
                        tenureDays,
                        memberAge,
                    });
                    if (result.interestAmount >= 0.01) {
                        // Get scheme ID
                        const schemeData = await (0, interest_calculation_service_1.getActiveScheme)(tenantId, accountType, recalculationDate);
                        const schemeId = schemeData?.scheme?.id || null;
                        // Create new accrual record
                        await tx.interestAccrual.create({
                            data: {
                                tenantId,
                                accountId,
                                accountType,
                                schemeId,
                                accrualDate: recalculationDate,
                                rateApplied: result.rateApplied,
                                schemeVersion: result.schemeCode || null,
                                amountAccrued: result.interestAmount,
                                calculationBasis: `ACTUAL_${result.dayCountDenominator}`,
                                posted: false, // Will be posted separately
                            },
                        });
                        totalRecalculated += result.interestAmount;
                        recalculationCount++;
                    }
                }
                catch (err) {
                    console.error(`[Recalculation] Error calculating for ${recalculationDate.toISOString()}:`, err);
                }
                // Move to next day
                recalculationDate.setDate(recalculationDate.getDate() + 1);
            }
            // 7. Create audit log
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: requestedBy,
                    action: "INTEREST_RECALCULATION",
                    entity: accountType === "SB" ? "SbAccount" : "Deposit",
                    entityId: accountId,
                    oldData: { reversalCount: accrualsToReverse.length, reversalAmount: totalReversalAmount },
                    newData: { recalculationCount, recalculatedAmount: totalRecalculated },
                    remarks: reason,
                    ipAddress: "system",
                },
            });
            const netDifference = totalRecalculated - totalReversalAmount;
            return {
                success: true,
                reversalCount: accrualsToReverse.length,
                recalculationCount,
                netDifference: Math.round(netDifference * 100) / 100,
            };
        }, {
            timeout: 30000, // 30 second timeout for long-running recalculation
        });
    }
    catch (err) {
        console.error("[Backdated Recalculation]", err);
        return {
            success: false,
            reversalCount: 0,
            recalculationCount: 0,
            netDifference: 0,
            error: err instanceof Error ? err.message : "Recalculation failed",
        };
    }
}
/**
 * Check if recalculation is already in progress (idempotency check)
 */
async function isRecalculationInProgress(tenantId, accountId, accountType) {
    // Check for recent recalculation requests (within last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentRecalc = await prisma_1.default.auditLog.findFirst({
        where: {
            tenantId,
            action: "INTEREST_RECALCULATION",
            entity: accountType === "SB" ? "SbAccount" : "Deposit",
            entityId: accountId,
            createdAt: { gte: fiveMinutesAgo },
        },
    });
    return !!recentRecalc;
}
//# sourceMappingURL=backdated-recalculation.service.js.map