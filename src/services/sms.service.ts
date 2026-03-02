/**
 * SMS usage tracking — decrement tenant smsCredits when SMS is sent.
 * Call recordSmsSent(tenantId) from any SMS-sending code (OTP, alerts, etc.).
 */
import prisma from "../db/prisma";

export async function recordSmsSent(tenantId: string): Promise<{ remaining: number }> {
    await prisma.tenantCredits.upsert({
        where: { tenantId },
        create: { tenantId, txCredits: 0, smsCredits: 0 },
        update: {},
    });
    const credits = await prisma.tenantCredits.update({
        where: { tenantId },
        data: { smsCredits: { decrement: 1 } },
    });
    const remaining = Math.max(0, credits.smsCredits);
    if (credits.smsCredits < 0) {
        await prisma.tenantCredits.update({
            where: { tenantId },
            data: { smsCredits: 0 },
        });
    }
    return { remaining };
}

export async function canSendSms(tenantId: string): Promise<boolean> {
    const credits = await prisma.tenantCredits.findUnique({
        where: { tenantId },
    });
    const balance = credits?.smsCredits ?? 0;
    return balance > 0;
}
