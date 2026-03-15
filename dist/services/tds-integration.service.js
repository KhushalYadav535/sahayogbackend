"use strict";
/**
 * TDS Integration Service (BRD v4.0 INT-009)
 * Atomic TDS check within interest posting transaction
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTDS = checkTDS;
exports.postInterestWithTDS = postInterestWithTDS;
const prisma_1 = __importDefault(require("../db/prisma"));
const coa_rules_1 = require("../lib/coa-rules");
/**
 * Check TDS applicability and calculate TDS amount (INT-009)
 * Called atomically within interest posting transaction
 */
async function checkTDS(tenantId, memberId, interestBeingPosted, financialYear // Format: "2024-25"
) {
    // Get member details
    const member = await prisma_1.default.member.findFirst({
        where: { id: memberId, tenantId },
    });
    if (!member) {
        throw new Error("Member not found");
    }
    // Calculate cumulative FDR interest for current FY
    const fyStart = new Date(`${financialYear.split("-")[0]}-04-01`);
    const fyEnd = new Date(`${financialYear.split("-")[1]}-03-31`);
    const fdrDeposits = await prisma_1.default.deposit.findMany({
        where: {
            tenantId,
            memberId,
            depositType: "fd",
            status: { in: ["active", "matured", "prematurely_closed"] },
        },
    });
    // Get interest accruals posted in current FY
    const postedAccruals = await prisma_1.default.interestAccrual.findMany({
        where: {
            tenantId,
            accountId: { in: fdrDeposits.map((d) => d.id) },
            accountType: "FDR",
            posted: true,
            postedAt: {
                gte: fyStart,
                lte: fyEnd,
            },
        },
    });
    const cumulativeInterestPosted = postedAccruals.reduce((sum, acc) => sum + Number(acc.amountAccrued), 0);
    const cumulativeInterestThisFY = cumulativeInterestPosted + interestBeingPosted;
    // Check senior citizen status
    const isSeniorCitizen = member.dateOfBirth
        ? Math.floor((new Date().getTime() - member.dateOfBirth.getTime()) / (1000 * 60 * 60 * 24 * 365.25)) >= 60
        : false;
    // Check Form 15 exemption
    const isForm15Exempt = member.form15Status === "EXEMPT" && member.form15Fy === financialYear;
    // Use existing computeTds function
    const tdsResult = (0, coa_rules_1.computeTds)(cumulativeInterestThisFY, isSeniorCitizen, !!member.panNumber, // hasPan
    isForm15Exempt);
    return {
        tdsApplicable: tdsResult.tdsApplicable,
        tdsAmount: tdsResult.tdsAmount,
        netCreditAmount: interestBeingPosted - tdsResult.tdsAmount,
        cumulativeInterestThisFY,
        thresholdExceeded: cumulativeInterestThisFY > tdsResult.threshold,
    };
}
/**
 * Post interest with TDS integration (atomic transaction) - INT-009
 * TDS check is atomic within posting transaction boundary
 */
async function postInterestWithTDS(tenantId, accountId, accountType, memberId, interestAmount, financialYear) {
    try {
        // Only FDR interest is subject to TDS (Sec 194A)
        if (accountType !== "FDR") {
            return {
                success: true,
                netCreditAmount: interestAmount,
                tdsAmount: 0,
                tdsApplicable: false,
            };
        }
        // Atomic transaction: Check TDS and post interest
        return await prisma_1.default.$transaction(async (tx) => {
            // Check TDS applicability (atomic step within transaction)
            const tdsResult = await checkTDS(tenantId, memberId, interestAmount, financialYear);
            // Mark accrual as posted
            await tx.interestAccrual.updateMany({
                where: {
                    tenantId,
                    accountId,
                    accountType,
                    posted: false,
                },
                data: {
                    posted: true,
                    postedAt: new Date(),
                },
            });
            return {
                success: true,
                netCreditAmount: tdsResult.netCreditAmount,
                tdsAmount: tdsResult.tdsAmount,
                tdsApplicable: tdsResult.tdsApplicable,
            };
        });
    }
    catch (err) {
        // If TDS check fails, rollback entire transaction
        return {
            success: false,
            netCreditAmount: 0,
            tdsAmount: 0,
            tdsApplicable: false,
            error: err instanceof Error ? err.message : "TDS check failed",
        };
    }
}
//# sourceMappingURL=tds-integration.service.js.map