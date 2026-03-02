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
}): Promise<void>;
//# sourceMappingURL=audit.d.ts.map