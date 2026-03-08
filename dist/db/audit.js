"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuditLog = createAuditLog;
const prisma_1 = __importDefault(require("./prisma"));
const crypto_1 = require("crypto");
/**
 * Module 14 - DA-005: Audit Trail Schema with Hash Chain
 * Creates audit log entry and maintains hash chain for immutability verification
 */
async function createAuditLog(params) {
    try {
        // Get previous hash for hash chain
        const lastHash = await prisma_1.default.auditLogHash.findFirst({
            where: { auditLogId: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { hash: true },
        });
        const previousHash = lastHash?.hash || null;
        // Create audit log entry
        const auditLog = await prisma_1.default.auditLog.create({
            data: {
                tenantId: params.tenantId,
                userId: params.userId,
                action: params.action,
                entity: params.entity,
                entityId: params.entityId,
                oldData: params.oldData ? params.oldData : undefined,
                newData: params.newData ? params.newData : undefined,
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
        const entryHash = (0, crypto_1.createHash)("sha256").update(entryContent).digest("hex").toUpperCase();
        // Create hash chain entry
        await prisma_1.default.auditLogHash.create({
            data: {
                auditLogId: auditLog.id,
                hash: entryHash,
                previousHash,
            },
        });
    }
    catch (err) {
        // Non-critical: log but don't throw
        console.error("[AuditLog] Failed to create audit log:", err);
    }
}
//# sourceMappingURL=audit.js.map