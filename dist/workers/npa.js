"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processNpa = processNpa;
exports.startNpaWorker = startNpaWorker;
/**
 * BullMQ NPA job — marks loans 90+ days overdue as NPA
 */
const bullmq_1 = require("bullmq");
const prisma_1 = __importDefault(require("../db/prisma"));
const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};
async function processNpa(job) {
    const tenantId = job.data.tenantId;
    const npaThreshold = new Date();
    npaThreshold.setDate(npaThreshold.getDate() - 90);
    const where = {
        status: "active",
        emiSchedule: {
            some: { status: "overdue", dueDate: { lt: npaThreshold } },
        },
    };
    if (tenantId)
        where.tenantId = tenantId;
    const loans = await prisma_1.default.loan.findMany({ where });
    let marked = 0;
    for (const loan of loans) {
        await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: { status: "npa", npaDate: new Date() },
        });
        marked++;
    }
    return { marked, tenantId };
}
function startNpaWorker() {
    const worker = new bullmq_1.Worker("npa", async (job) => processNpa(job), { connection });
    worker.on("completed", (job) => console.log(`[npa] Job ${job.id} completed`));
    worker.on("failed", (job, err) => console.error(`[npa] Job ${job?.id} failed:`, err));
    return worker;
}
//# sourceMappingURL=npa.js.map