/**
 * Interest Calculation Service (BRD v4.0)
 * INT-002: Slab Application Method (FLAT/MARGINAL)
 * INT-003: Day-Count Convention
 * INT-004A: Senior Citizen Eligibility & Rate Lock
 * INT-004B: Pre-closure Interest Rule
 */
export type ProductType = "SB" | "FDR" | "RD" | "Loan";
export type SlabApplicationMethod = "FLAT" | "MARGINAL";
export type DayCountConvention = "ACTUAL_365" | "ACTUAL_ACTUAL";
export interface InterestCalculationInput {
    tenantId: string;
    productType: ProductType;
    principal: number;
    rate?: number;
    calculationDate: Date;
    tenureDays?: number;
    memberAge?: number;
    slabApplicationMethod?: SlabApplicationMethod;
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
export declare function getDayCountDenominator(convention: DayCountConvention, startDate: Date, endDate: Date): number;
/**
 * Get active interest scheme for a product type on a given date
 */
export declare function getActiveScheme(tenantId: string, productType: ProductType, date: Date): Promise<{
    scheme: any;
    slabs: any[];
} | null>;
/**
 * Main interest calculation function
 */
export declare function calculateInterest(input: InterestCalculationInput): Promise<InterestCalculationResult>;
/**
 * Calculate pre-closure interest with zero-floor rule (INT-004B)
 */
export declare function calculatePreClosureInterest(tenantId: string, productType: "FDR" | "RD", principal: number, originalTenureDays: number, actualTenureDays: number, memberAge?: number): Promise<{
    interestAmount: number;
    rateApplied: number;
    penaltyAmount: number;
    netInterest: number;
}>;
//# sourceMappingURL=interest-calculation.service.d.ts.map