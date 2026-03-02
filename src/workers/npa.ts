/**
 * BullMQ NPA job — marks loans 90+ days overdue as NPA
 */
import { Worker, Job } from "bullmq";
import prisma from "../db/prisma";

const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

export async function processNpa(job: Job<{ tenantId?: string }>) {
    const tenantId = job.data.tenantId;
    const npaThreshold = new Date();
    npaThreshold.setDate(npaThreshold.getDate() - 90);

    const where: Record<string, unknown> = {
        status: "active",
        emiSchedule: {
            some: { status: "overdue", dueDate: { lt: npaThreshold } },
        },
    };
    if (tenantId) where.tenantId = tenantId;

    const loans = await prisma.loan.findMany({ where });
    let marked = 0;
    for (const loan of loans) {
        await prisma.loan.update({
            where: { id: loan.id },
            data: { status: "npa", npaDate: new Date() },
        });
        marked++;
    }
    return { marked, tenantId };
}

export function startNpaWorker() {
    const worker = new Worker(
        "npa",
        async (job) => processNpa(job),
        { connection }
    );
    worker.on("completed", (job) => console.log(`[npa] Job ${job.id} completed`));
    worker.on("failed", (job, err) => console.error(`[npa] Job ${job?.id} failed:`, err));
    return worker;
}
