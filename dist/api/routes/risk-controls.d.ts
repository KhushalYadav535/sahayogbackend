declare const router: import("express-serve-static-core").Router;
export declare function checkTransactionVelocity(tenantId: string, accountId: string, transactionType: string, amount: number): Promise<{
    allowed: boolean;
    reason?: string;
    velocityId?: string;
}>;
export declare function checkDailyLimit(tenantId: string, userId: string | null, accountId: string | null, amount: number, limitType: "USER_CASH" | "ACCOUNT_CASH"): Promise<{
    allowed: boolean;
    remaining?: number;
    reason?: string;
}>;
export default router;
//# sourceMappingURL=risk-controls.d.ts.map