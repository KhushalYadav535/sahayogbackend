/**
 * Module 14 - DA-005: Audit Trail Schema with Hash Chain
 * Creates audit log entry and maintains hash chain for immutability verification
 */
export declare function createAuditLog(params: {
    tenantId?: string;
    userId?: string;
    action: string;
    entity: string;
    entityId?: string;
    oldData?: unknown;
    newData?: unknown;
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
}): Promise<void>;
//# sourceMappingURL=audit.d.ts.map