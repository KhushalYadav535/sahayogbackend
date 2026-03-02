"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuditLog = createAuditLog;
const prisma_1 = __importDefault(require("./prisma"));
async function createAuditLog(params) {
    try {
        await prisma_1.default.auditLog.create({
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
    }
    catch (err) {
        // Non-critical: log but don't throw
        console.error("[AuditLog] Failed to create audit log:", err);
    }
}
//# sourceMappingURL=audit.js.map