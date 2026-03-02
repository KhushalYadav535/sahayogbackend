import prisma from "../db/prisma";

export async function createAiAuditLog(params: {
    tenantId?: string;
    userId?: string;
    feature: string;
    inputData?: unknown;
    outputData?: unknown;
    confidence?: number;
    latencyMs?: number;
    success?: boolean;
    errorMsg?: string;
}) {
    try {
        await prisma.aiAuditLog.create({
            data: {
                tenantId: params.tenantId,
                userId: params.userId,
                feature: params.feature,
                inputData: params.inputData ? (params.inputData as object) : undefined,
                outputData: params.outputData
                    ? (params.outputData as object)
                    : undefined,
                confidence: params.confidence,
                latencyMs: params.latencyMs,
                success: params.success ?? true,
                errorMsg: params.errorMsg,
            },
        });
    } catch (err) {
        console.error("[AI AuditLog] Failed:", err);
    }
}
