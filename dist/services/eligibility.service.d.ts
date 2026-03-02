export interface EligibilityRule {
    field: string;
    operator: "<" | "<=" | "==" | ">=" | ">";
    value: number | string;
}
export interface EligibilityResult {
    eligible: boolean;
    failedRules: {
        field: string;
        reason: string;
    }[];
    passedRules: string[];
}
export declare function evaluateEligibility(tenantId: string, memberId: string): Promise<{
    result: EligibilityResult;
    ruleVersion: string;
}>;
//# sourceMappingURL=eligibility.service.d.ts.map