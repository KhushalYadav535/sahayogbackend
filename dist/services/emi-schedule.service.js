"use strict";
/**
 * EMI Schedule Generator (BRD v4.0 INT-006)
 * Implements rounding modes and final installment adjustment
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateEMISchedule = generateEMISchedule;
const prisma_1 = __importDefault(require("../db/prisma"));
/**
 * Round a number based on rounding mode
 */
function roundAmount(amount, mode) {
    switch (mode) {
        case "ROUND_UP":
            return Math.ceil(amount * 100) / 100;
        case "ROUND_DOWN":
            return Math.floor(amount * 100) / 100;
        case "HALF_EVEN":
            // Banker's rounding: round half to nearest even number
            const rounded = Math.round(amount * 100) / 100;
            const remainder = (amount * 100) % 1;
            if (Math.abs(remainder) === 0.5) {
                // Round to nearest even
                const floor = Math.floor(amount * 100);
                return (floor % 2 === 0 ? floor : floor + 1) / 100;
            }
            return rounded;
        default:
            return Math.round(amount * 100) / 100;
    }
}
/**
 * Generate EMI schedule with rounding and final installment adjustment
 */
async function generateEMISchedule(tenantId, principal, annualRate, tenureMonths, disbursementDate, moratoriumMonths = 0) {
    // Get rounding mode from tenant config
    const roundingConfig = await prisma_1.default.systemConfig.findFirst({
        where: {
            tenantId,
            key: "emi.rounding.mode",
        },
    });
    const roundingMode = (roundingConfig?.value || "HALF_EVEN");
    // Calculate monthly rate
    const monthlyRate = annualRate / 1200; // annualRate is in percentage
    // Calculate EMI using standard formula: P × r × (1+r)^n / ((1+r)^n - 1)
    const emiNumerator = principal * monthlyRate * Math.pow(1 + monthlyRate, tenureMonths);
    const emiDenominator = Math.pow(1 + monthlyRate, tenureMonths) - 1;
    const emi = emiNumerator / emiDenominator;
    // Round EMI based on rounding mode
    const roundedEmi = roundAmount(emi, roundingMode);
    // Generate schedule
    const schedule = [];
    let runningBalance = principal;
    let cumulativePrincipal = 0;
    let cumulativeRoundingResidual = 0;
    for (let i = 0; i < tenureMonths; i++) {
        const dueDate = new Date(disbursementDate);
        dueDate.setMonth(dueDate.getMonth() + moratoriumMonths + i + 1);
        const openingBalance = runningBalance;
        // Calculate interest component for this period
        const interestComponent = runningBalance * monthlyRate;
        // Calculate principal component
        let principalComponent = roundedEmi - interestComponent;
        // For final installment, adjust to absorb rounding residual
        const isFinal = i === tenureMonths - 1;
        if (isFinal) {
            // Pay off remaining balance exactly
            principalComponent = runningBalance;
        }
        // Round components
        const roundedInterest = roundAmount(interestComponent, roundingMode);
        const roundedPrincipal = roundAmount(principalComponent, roundingMode);
        // Adjust if rounding causes total to not equal EMI (except final)
        let totalEmi = roundedInterest + roundedPrincipal;
        if (!isFinal) {
            // Ensure total equals rounded EMI
            if (Math.abs(totalEmi - roundedEmi) > 0.01) {
                // Adjust principal to match EMI
                principalComponent = roundedEmi - roundedInterest;
                roundedPrincipal = principalComponent;
                totalEmi = roundedEmi;
            }
        }
        else {
            // Final EMI may differ due to rounding absorption
            totalEmi = roundedInterest + principalComponent;
        }
        const closingBalance = openingBalance - principalComponent;
        cumulativePrincipal += principalComponent;
        runningBalance = closingBalance;
        schedule.push({
            installmentNo: i + 1,
            dueDate,
            openingBalance: Math.round(openingBalance * 100) / 100,
            principalComponent: Math.round(principalComponent * 100) / 100,
            interestComponent: Math.round(roundedInterest * 100) / 100,
            closingBalance: Math.round(closingBalance * 100) / 100,
            totalEmi: Math.round(totalEmi * 100) / 100,
            isAdjustedFinal: isFinal,
        });
    }
    // Verify: sum of principal components should equal original principal (within rounding tolerance)
    const totalPrincipalPaid = schedule.reduce((sum, item) => sum + item.principalComponent, 0);
    const principalDifference = Math.abs(totalPrincipalPaid - principal);
    if (principalDifference > 0.01) {
        // Adjust final installment to absorb difference
        const finalItem = schedule[schedule.length - 1];
        finalItem.principalComponent += (principal - totalPrincipalPaid);
        finalItem.closingBalance = finalItem.openingBalance - finalItem.principalComponent;
        finalItem.totalEmi = finalItem.interestComponent + finalItem.principalComponent;
        finalItem.isAdjustedFinal = true;
    }
    return schedule;
}
//# sourceMappingURL=emi-schedule.service.js.map