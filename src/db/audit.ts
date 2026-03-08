import prisma from "./prisma";
import { createHash } from "crypto";

/**
 * Module 14 - DA-005: Audit Trail Schema with Hash Chain
 * Creates audit log entry and maintains hash chain for immutability verification
 */
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
    sessionId?: string;
}) {
    try {
        // Get previous hash for hash chain
        const lastHash = await prisma.auditLogHash.findFirst({
            where: { auditLogId: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { hash: true },
        });

        const previousHash = lastHash?.hash || null;

        // Create audit log entry
        const auditLog = await prisma.auditLog.create({
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

        // Compute hash of this entry (content + previous hash)
        const entryContent = JSON.stringify({
            id: auditLog.id,
            tenantId: auditLog.tenantId,
            userId: auditLog.userId,
            action: auditLog.action,
            entity: auditLog.entity,
            entityId: auditLog.entityId,
            oldData: auditLog.oldData,
            newData: auditLog.newData,
            ipAddress: auditLog.ipAddress,
            userAgent: auditLog.userAgent,
            createdAt: auditLog.createdAt.toISOString(),
            previousHash,
        });

        const entryHash = createHash("sha256").update(entryContent).digest("hex").toUpperCase();

        // Create hash chain entry
        await prisma.auditLogHash.create({
            data: {
                auditLogId: auditLog.id,
                hash: entryHash,
                previousHash,
            },
        });
    } catch (err) {
        // Non-critical: log but don't throw
        console.error("[AuditLog] Failed to create audit log:", err);
    }
}
