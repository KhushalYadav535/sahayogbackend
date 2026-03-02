/**
 * BullMQ day-end job — applies daily SB interest
 * Scheduled via BullMQ; can also be triggered via POST /api/v1/jobs/day-end
 */
import { Worker, Job } from "bullmq";
import prisma from "../db/prisma";

const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

export async function processDayEnd(job: Job<{ tenantId: string }>) {
    const { tenantId } = job.data;
    const accounts = await prisma.sbAccount.findMany({
        where: { tenantId, status: "active" },
    });

    let processed = 0;
    for (const acct of accounts) {
        const dailyInterest = (Number(acct.balance) * Number(acct.interestRate)) / (100 * 365);
        if (dailyInterest > 0.01) {
            const newBalance = Number(acct.balance) + dailyInterest;
            await prisma.$transaction([
                prisma.sbAccount.update({ where: { id: acct.id }, data: { balance: newBalance } }),
                prisma.transaction.create({
                    data: {
                        accountId: acct.id,
                        type: "credit",
                        category: "interest",
                        amount: dailyInterest,
                        balanceAfter: newBalance,
                        remarks: "Daily interest (BullMQ)",
                    },
                }),
            ]);
            processed++;
        }
    }

    await prisma.emiSchedule.updateMany({
        where: { dueDate: { lt: new Date() }, status: "pending", loan: { tenantId } },
        data: { status: "overdue" },
    });

    return { processed, tenantId };
}

export function startDayEndWorker() {
    const worker = new Worker(
        "day-end",
        async (job) => processDayEnd(job),
        { connection }
    );
    worker.on("completed", (job) => console.log(`[day-end] Job ${job.id} completed`));
    worker.on("failed", (job, err) => console.error(`[day-end] Job ${job?.id} failed:`, err));
    return worker;
}
