/**
 * EMI Schedule Generator (BRD v4.0 INT-006)
 * Implements rounding modes and final installment adjustment
 */
export type RoundingMode = "ROUND_UP" | "ROUND_DOWN" | "HALF_EVEN";
export interface EMIScheduleItem {
    installmentNo: number;
    dueDate: Date;
    openingBalance: number;
    principalComponent: number;
    interestComponent: number;
    penalInterest?: number;
    closingBalance: number;
    totalEmi: number;
    isAdjustedFinal?: boolean;
}
/**
 * Generate EMI schedule with rounding and final installment adjustment
 */
export declare function generateEMISchedule(tenantId: string, principal: number, annualRate: number, tenureMonths: number, disbursementDate: Date, moratoriumMonths?: number): Promise<EMIScheduleItem[]>;
//# sourceMappingURL=emi-schedule.service.d.ts.map