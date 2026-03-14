/**
 * Interest Calculation Service (BRD v4.0)
 * INT-002: Slab Application Method (FLAT/MARGINAL)
 * INT-003: Day-Count Convention
 * INT-004A: Senior Citizen Eligibility & Rate Lock
 * INT-004B: Pre-closure Interest Rule
 */

import prisma from "../db/prisma";
import { Decimal } from "@prisma/client/runtime/library";

export type ProductType = "SB" | "FDR" | "RD" | "Loan";
export type SlabApplicationMethod = "FLAT" | "MARGINAL";
export type DayCountConvention = "ACTUAL_365" | "ACTUAL_ACTUAL";

export interface InterestCalculationInput {
    tenantId: string;
    productType: ProductType;
    principal: number;
    rate?: number; // If not provided, will lookup from active scheme
    calculationDate: Date;
    tenureDays?: number;
    memberAge?: number; // For senior citizen check
    slabApplicationMethod?: SlabApplicationMethod; // Override scheme default
}

export interface InterestCalculationResult {
    interestAmount: number;
    rateApplied: number;
    schemeCode?: string;
    slabApplicationMethod: SlabApplicationMethod;
    dayCountDenominator: number;
    daysUsed: number;
    seniorCitizenPremium?: number;
}

/**
 * Get day-count denominator based on convention
 */
export function getDayCountDenominator(
    convention: DayCountConvention,
    startDate: Date,
    endDate: Date
): number {
    if (convention === "ACTUAL_365") {
        return 365; // Always 365, even in leap years
    } else if (convention === "ACTUAL_ACTUAL") {
        // Count actual days, use 366 for leap years
        const year = endDate.getFullYear();
        const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return isLeapYear ? 366 : 365;
    }
    return 365; // Default
}

/**
 * Get active interest scheme for a product type on a given date
 */
export async function getActiveScheme(
    tenantId: string,
    productType: ProductType,
    date: Date
): Promise<{
    scheme: any;
    slabs: any[];
} | null> {
    const scheme = await prisma.interestScheme.findFirst({
        where: {
            tenantId,
            productType,
            status: "ACTIVE",
            effectiveFromDate: { lte: date },
            OR: [
                { effectiveToDate: null },
                { effectiveToDate: { gte: date } },
            ],
        },
        include: {
            slabs: {
                orderBy: [
                    { minAmount: "asc" },
                    { minTenureDays: "asc" },
                ],
            },
        },
        orderBy: { effectiveFromDate: "desc" },
    });

    return scheme;
}

/**
 * Calculate interest using FLAT slab method
 * Rate for the slab in which the full balance falls is applied to total balance
 */
function calculateFlatSlabInterest(
    principal: number,
    slabs: any[],
    dayCountDenominator: number,
    days: number
): { interest: number; rateApplied: number } {
    // Find the slab that contains the principal
    let applicableSlab = null;
    let rateApplied = 0;

    for (const slab of slabs) {
        const minAmount = slab.minAmount ? Number(slab.minAmount) : 0;
        const maxAmount = slab.maxAmount ? Number(slab.maxAmount) : Infinity;
        const minTenureDays = slab.minTenureDays || 0;
        const maxTenureDays = slab.maxTenureDays || Infinity;

        // For balance-based slabs (SB)
        if (slab.minAmount !== null && principal >= minAmount && principal <= maxAmount) {
            applicableSlab = slab;
            rateApplied = Number(slab.rate);
            break;
        }

        // For tenure-based slabs (FDR/RD)
        if (slab.minTenureDays !== null && days >= minTenureDays && days <= maxTenureDays) {
            applicableSlab = slab;
            rateApplied = Number(slab.rate);
            break;
        }
    }

    if (!applicableSlab || rateApplied === 0) {
        throw new Error(`No applicable slab found for principal ${principal} or tenure ${days} days`);
    }

    const interest = (principal * rateApplied * days) / (100 * dayCountDenominator);
    return { interest, rateApplied };
}

/**
 * Calculate interest using MARGINAL slab method
 * Each portion of balance is taxed at the rate of the slab it falls within
 */
function calculateMarginalSlabInterest(
    principal: number,
    slabs: any[],
    dayCountDenominator: number,
    days: number
): { interest: number; rateApplied: number } {
    let totalInterest = 0;
    let remainingPrincipal = principal;
    let weightedRateSum = 0;
    let totalWeight = 0;

    // Sort slabs by minAmount or minTenureDays
    const sortedSlabs = [...slabs].sort((a, b) => {
        if (a.minAmount !== null && b.minAmount !== null) {
            return Number(a.minAmount) - Number(b.minAmount);
        }
        if (a.minTenureDays !== null && b.minTenureDays !== null) {
            return (a.minTenureDays || 0) - (b.minTenureDays || 0);
        }
        return 0;
    });

    for (const slab of sortedSlabs) {
        if (remainingPrincipal <= 0) break;

        const minAmount = slab.minAmount ? Number(slab.minAmount) : 0;
        const maxAmount = slab.maxAmount ? Number(slab.maxAmount) : Infinity;
        const minTenureDays = slab.minTenureDays || 0;
        const maxTenureDays = slab.maxTenureDays || Infinity;

        // For balance-based slabs (SB)
        if (slab.minAmount !== null) {
            if (principal > maxAmount) {
                // Principal exceeds this slab, calculate interest on slab range
                const slabAmount = maxAmount - minAmount;
                const rate = Number(slab.rate);
                const interest = (slabAmount * rate * days) / (100 * dayCountDenominator);
                totalInterest += interest;
                weightedRateSum += rate * slabAmount;
                totalWeight += slabAmount;
            } else if (principal > minAmount) {
                // Principal falls in this slab
                const slabAmount = principal - minAmount;
                const rate = Number(slab.rate);
                const interest = (slabAmount * rate * days) / (100 * dayCountDenominator);
                totalInterest += interest;
                weightedRateSum += rate * slabAmount;
                totalWeight += slabAmount;
                remainingPrincipal = 0;
            }
        }

        // For tenure-based slabs (FDR/RD) - use first matching slab
        if (slab.minTenureDays !== null && days >= minTenureDays && days <= maxTenureDays) {
            const rate = Number(slab.rate);
            const interest = (principal * rate * days) / (100 * dayCountDenominator);
            totalInterest += interest;
            rateApplied = rate;
            remainingPrincipal = 0;
            break;
        }
    }

    // Calculate weighted average rate for balance-based slabs
    const rateApplied = totalWeight > 0 ? weightedRateSum / totalWeight : 0;

    return { interest: totalInterest, rateApplied };
}

/**
 * Main interest calculation function
 */
export async function calculateInterest(
    input: InterestCalculationInput
): Promise<InterestCalculationResult> {
    const {
        tenantId,
        productType,
        principal,
        rate: providedRate,
        calculationDate,
        tenureDays = 0,
        memberAge,
        slabApplicationMethod: overrideSlabMethod,
    } = input;

    // Get platform parameter for day-count convention
    const dayCountConfig = await prisma.systemConfig.findFirst({
        where: {
            tenantId: "PLATFORM",
            key: "interest.day.count.convention",
        },
    });

    const convention = (dayCountConfig?.value || "ACTUAL_365") as DayCountConvention;

    // Get active scheme if rate not provided
    let scheme = null;
    let slabs: any[] = [];
    let rateApplied = providedRate || 0;
    let schemeCode: string | undefined;
    let slabApplicationMethod: SlabApplicationMethod = "FLAT";

    if (!providedRate) {
        const schemeData = await getActiveScheme(tenantId, productType, calculationDate);
        if (!schemeData) {
            throw new Error(`No active interest scheme found for ${productType} on ${calculationDate.toISOString()}`);
        }
        scheme = schemeData.scheme;
        slabs = schemeData.slabs;
        schemeCode = scheme.schemeCode;
        slabApplicationMethod = (overrideSlabMethod || scheme.slabApplicationMethod || "FLAT") as SlabApplicationMethod;
    } else {
        slabApplicationMethod = overrideSlabMethod || "FLAT";
    }

    // Calculate days (for FDR/RD, use tenureDays; for SB, use 1 day for daily accrual)
    const days = productType === "SB" ? 1 : (tenureDays || 1);
    const startDate = new Date(calculationDate);
    const endDate = new Date(calculationDate);
    endDate.setDate(endDate.getDate() + days);

    const dayCountDenominator = getDayCountDenominator(convention, startDate, endDate);

    // Check senior citizen eligibility (for FDR)
    let seniorCitizenPremium = 0;
    if (productType === "FDR" && memberAge !== undefined) {
        const seniorAgeConfig = await prisma.systemConfig.findFirst({
            where: {
                tenantId: "PLATFORM",
                key: "fdr.senior.citizen.age.years",
            },
        });
        const seniorAgeThreshold = parseInt(seniorAgeConfig?.value || "60", 10);

        if (memberAge >= seniorAgeThreshold) {
            const premiumConfig = await prisma.systemConfig.findFirst({
                where: {
                    tenantId,
                    key: "fdr.senior.citizen.rate.premium",
                },
            });
            seniorCitizenPremium = parseFloat(premiumConfig?.value || "0.50");
        }
    }

    // Calculate interest
    let interestAmount = 0;

    if (providedRate) {
        // Direct rate calculation
        rateApplied = providedRate + seniorCitizenPremium;
        interestAmount = (principal * rateApplied * days) / (100 * dayCountDenominator);
    } else if (slabs.length > 0) {
        // Slab-based calculation
        if (slabApplicationMethod === "MARGINAL") {
            const result = calculateMarginalSlabInterest(principal, slabs, dayCountDenominator, days);
            interestAmount = result.interest;
            rateApplied = result.rateApplied + seniorCitizenPremium;
        } else {
            const result = calculateFlatSlabInterest(principal, slabs, dayCountDenominator, days);
            interestAmount = result.interest;
            rateApplied = result.rateApplied + seniorCitizenPremium;
        }
    } else {
        throw new Error("No rate or scheme slabs provided");
    }

    return {
        interestAmount: Math.round(interestAmount * 100) / 100, // Round to 2 decimals
        rateApplied: Math.round(rateApplied * 100) / 100,
        schemeCode,
        slabApplicationMethod,
        dayCountDenominator,
        daysUsed: days,
        seniorCitizenPremium: seniorCitizenPremium > 0 ? seniorCitizenPremium : undefined,
    };
}

/**
 * Calculate pre-closure interest with zero-floor rule (INT-004B)
 */
export async function calculatePreClosureInterest(
    tenantId: string,
    productType: "FDR" | "RD",
    principal: number,
    originalTenureDays: number,
    actualTenureDays: number,
    memberAge?: number
): Promise<{
    interestAmount: number;
    rateApplied: number;
    penaltyAmount: number;
    netInterest: number;
}> {
    // Get premature penalty percentage
    const penaltyConfig = await prisma.systemConfig.findFirst({
        where: {
            tenantId,
            key: "fdr.premature.penalty.pct",
        },
    });
    const penaltyPct = parseFloat(penaltyConfig?.value || "1.00");

    // Get active scheme for actual tenure
    const calculationDate = new Date();
    const schemeData = await getActiveScheme(tenantId, productType, calculationDate);
    if (!schemeData) {
        throw new Error(`No active interest scheme found for ${productType}`);
    }

    // Find rate for actual tenure
    let rateForActualTenure = 0;
    for (const slab of schemeData.slabs) {
        if (slab.minTenureDays !== null && slab.maxTenureDays !== null) {
            if (actualTenureDays >= slab.minTenureDays && actualTenureDays <= slab.maxTenureDays) {
                rateForActualTenure = Number(slab.rate);
                break;
            }
        }
    }

    if (rateForActualTenure === 0) {
        throw new Error(`No rate found for tenure ${actualTenureDays} days`);
    }

    // Add senior citizen premium if applicable
    if (memberAge !== undefined) {
        const seniorAgeConfig = await prisma.systemConfig.findFirst({
            where: {
                tenantId: "PLATFORM",
                key: "fdr.senior.citizen.age.years",
            },
        });
        const seniorAgeThreshold = parseInt(seniorAgeConfig?.value || "60", 10);

        if (memberAge >= seniorAgeThreshold) {
            const premiumConfig = await prisma.systemConfig.findFirst({
                where: {
                    tenantId,
                    key: "fdr.senior.citizen.rate.premium",
                },
            });
            rateForActualTenure += parseFloat(premiumConfig?.value || "0.50");
        }
    }

    // Calculate interest at actual tenure rate
    const dayCountConfig = await prisma.systemConfig.findFirst({
        where: {
            tenantId: "PLATFORM",
            key: "interest.day.count.convention",
        },
    });
    const convention = (dayCountConfig?.value || "ACTUAL_365") as DayCountConvention;
    const dayCountDenominator = getDayCountDenominator(convention, new Date(), new Date());

    const interestAtActualRate = (principal * rateForActualTenure * actualTenureDays) / (100 * dayCountDenominator);
    const penaltyAmount = (interestAtActualRate * penaltyPct) / 100;
    let netInterest = interestAtActualRate - penaltyAmount;

    // Apply zero-floor rule (fdr.preclosure.minimum.interest.floor = TRUE)
    const floorConfig = await prisma.systemConfig.findFirst({
        where: {
            tenantId: "PLATFORM",
            key: "fdr.preclosure.minimum.interest.floor",
        },
    });
    const applyZeroFloor = floorConfig?.value === "TRUE" || floorConfig?.value === "true";

    if (applyZeroFloor && netInterest < 0) {
        netInterest = 0;
    }

    return {
        interestAmount: Math.round(interestAtActualRate * 100) / 100,
        rateApplied: Math.round(rateForActualTenure * 100) / 100,
        penaltyAmount: Math.round(penaltyAmount * 100) / 100,
        netInterest: Math.round(netInterest * 100) / 100,
    };
}
