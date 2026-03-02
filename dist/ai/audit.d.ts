export declare function createAiAuditLog(params: {
    tenantId?: string;
    userId?: string;
    feature: string;
    inputData?: unknown;
    outputData?: unknown;
    confidence?: number;
    latencyMs?: number;
    success?: boolean;
    errorMsg?: string;
}): Promise<void>;
//# sourceMappingURL=audit.d.ts.map