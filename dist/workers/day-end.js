"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDayEnd = processDayEnd;
exports.startDayEndWorker = startDayEndWorker;
/**
 * BullMQ day-end job — applies daily SB interest
 * Scheduled via BullMQ; can also be triggered via POST /api/v1/jobs/day-end
 */
const bullmq_1 = require("bullmq");
const prisma_1 = __importDefault(require("../db/prisma"));
const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};
async function processDayEnd(job) {
    const { tenantId } = job.data;
    const accounts = await prisma_1.default.sbAccount.findMany({
        where: { tenantId, status: "active" },
    });
    let processed = 0;
    for (const acct of accounts) {
        const dailyInterest = (Number(acct.balance) * Number(acct.interestRate)) / (100 * 365);
        if (dailyInterest > 0.01) {
            const newBalance = Number(acct.balance) + dailyInterest;
            await prisma_1.default.$transaction([
                prisma_1.default.sbAccount.update({ where: { id: acct.id }, data: { balance: newBalance } }),
                prisma_1.default.transaction.create({
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
    await prisma_1.default.emiSchedule.updateMany({
        where: { dueDate: { lt: new Date() }, status: "pending", loan: { tenantId } },
        data: { status: "overdue" },
    });
    return { processed, tenantId };
}
function startDayEndWorker() {
    const worker = new bullmq_1.Worker("day-end", async (job) => processDayEnd(job), { connection });
    worker.on("completed", (job) => console.log(`[day-end] Job ${job.id} completed`));
    worker.on("failed", (job, err) => console.error(`[day-end] Job ${job?.id} failed:`, err));
    return worker;
}
//# sourceMappingURL=day-end.js.map