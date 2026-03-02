"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordSmsSent = recordSmsSent;
exports.canSendSms = canSendSms;
/**
 * SMS usage tracking — decrement tenant smsCredits when SMS is sent.
 * Call recordSmsSent(tenantId) from any SMS-sending code (OTP, alerts, etc.).
 */
const prisma_1 = __importDefault(require("../db/prisma"));
async function recordSmsSent(tenantId) {
    await prisma_1.default.tenantCredits.upsert({
        where: { tenantId },
        create: { tenantId, txCredits: 0, smsCredits: 0 },
        update: {},
    });
    const credits = await prisma_1.default.tenantCredits.update({
        where: { tenantId },
        data: { smsCredits: { decrement: 1 } },
    });
    const remaining = Math.max(0, credits.smsCredits);
    if (credits.smsCredits < 0) {
        await prisma_1.default.tenantCredits.update({
            where: { tenantId },
            data: { smsCredits: 0 },
        });
    }
    return { remaining };
}
async function canSendSms(tenantId) {
    const credits = await prisma_1.default.tenantCredits.findUnique({
        where: { tenantId },
    });
    const balance = credits?.smsCredits ?? 0;
    return balance > 0;
}
//# sourceMappingURL=sms.service.js.map