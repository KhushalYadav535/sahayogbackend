import prisma from "./prisma";

export async function createAuditLog(params: {
    tenantId?: string;
    userId?: string;
    action: string;
    entity: string;
    entityId?: string;
    oldData?: unknown;
    newData?: unknown;
    ipAddress?: string;
    userAgent?: string;
}) {
    try {
        await prisma.auditLog.create({
            data: {
                tenantId: params.tenantId,
                userId: params.userId,
                action: params.action,
                entity: params.entity,
                entityId: params.entityId,
                oldData: params.oldData ? (params.oldData as object) : undefined,
                newData: params.newData ? (params.newData as object) : undefined,
                ipAddress: params.ipAddress,
                userAgent: params.userAgent,
            },
        });
    } catch (err) {
        // Non-critical: log but don't throw
        console.error("[AuditLog] Failed to create audit log:", err);
    }
}
