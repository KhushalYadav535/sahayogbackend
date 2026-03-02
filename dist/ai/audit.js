"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAiAuditLog = createAiAuditLog;
const prisma_1 = __importDefault(require("../db/prisma"));
async function createAiAuditLog(params) {
    try {
        await prisma_1.default.aiAuditLog.create({
            data: {
                tenantId: params.tenantId,
                userId: params.userId,
                feature: params.feature,
                inputData: params.inputData ? params.inputData : undefined,
                outputData: params.outputData
                    ? params.outputData
                    : undefined,
                confidence: params.confidence,
                latencyMs: params.latencyMs,
                success: params.success ?? true,
                errorMsg: params.errorMsg,
            },
        });
    }
    catch (err) {
        console.error("[AI AuditLog] Failed:", err);
    }
}
//# sourceMappingURL=audit.js.map