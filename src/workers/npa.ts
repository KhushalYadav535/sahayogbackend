/**
 * Sahayog AI — NPA Worker
 * Full IRAC classification per RBI norms.
 * Runs daily via BullMQ; also callable from jobs.ts.
 */
import { Worker, Job } from "bullmq";
import prisma from "../db/prisma";
import { postGl, currentPeriod } from "../lib/gl-posting";
import {
    getNpaCategory,
    isNpa,
    NPA_PROVISION_RATES,
    NPA_PROVISION_GL_CREDIT,
    type NpaCategory,
} from "../lib/coa-rules";

const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

/** Compute days past due from oldest overdue EMI */
function computeDpd(oldestOverdueDueDate: Date | null): number {
    if (!oldestOverdueDueDate) return 0;
    const today = new Date();
    const diffMs = today.getTime() - oldestOverdueDueDate.getTime();
    return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Full IRAC classification job.
 * For each active/NPA loan:
 *   1. Find oldest overdue EMI → compute DPD
 *   2. Classify into NPA bucket
 *   3. Compute required provision amount
 *   4. Post quarterly provision GL if changed
 *   5. Move interest to suspense for NPA loans (monthly)
 */
export async function processNpa(job: Job<{ tenantId?: string }>) {
    const tenantId = job.data.tenantId;
    const period = currentPeriod();
    const now = new Date();
    const isQuarterEnd = [3, 6, 9, 12].includes(now.getMonth() + 1) && now.getDate() === new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    const where: Record<string, unknown> = {
        status: { in: ["active", "npa"] },
    };
    if (tenantId) where.tenantId = tenantId;

    const loans = await prisma.loan.findMany({
        where,
        include: {
            emiSchedule: {
                where: { status: "overdue" },
                orderBy: { dueDate: "asc" },
                take: 1,
            },
        },
    });

    let classified = 0;
    let provisioned = 0;
    let suspensePosted = 0;

    for (const loan of loans) {
        const oldestOverdue = loan.emiSchedule[0] ?? null;
        const dpd = computeDpd(oldestOverdue?.dueDate ?? null);
        const prevCategory = (loan.npaCategory ?? "standard") as NpaCategory;

        // If manually marked as loss, don't auto-downgrade
        let newCategory: NpaCategory = loan.npaCategory === "loss" ? "loss" : getNpaCategory(dpd);

        const outstanding = Number(loan.outstandingPrincipal);
        const provisionRate = NPA_PROVISION_RATES[newCategory];
        const requiredProvision = Math.round(outstanding * provisionRate * 100) / 100;

        const updates: Record<string, unknown> = {
            npaCategory: newCategory,
            npaDpd: dpd,
            npaProvision: requiredProvision,
        };

        // If entering NPA for the first time
        if (isNpa(newCategory) && !isNpa(prevCategory)) {
            updates.npaDate = new Date();
            updates.status = "npa";
        }

        // If cured from NPA back to standard
        if (!isNpa(newCategory) && isNpa(prevCategory)) {
            updates.status = "active";
            updates.npaDate = null;
            // Post provision reversal
            const prevProvision = Number(loan.npaProvision ?? 0);
            if (prevProvision > 0) {
                const prevGlCode = NPA_PROVISION_GL_CREDIT[prevCategory];
                await postGl(
                    loan.tenantId,
                    "NPA_PROVISION_REVERSAL",
                    prevProvision,
                    `Provision reversal — ${loan.loanNumber} cured to ${newCategory}`,
                    period,
                    { provisionGlCode: prevGlCode }
                );
            }
        }

        await prisma.loan.update({ where: { id: loan.id }, data: updates });
        classified++;

        // Post quarterly provision GL on quarter-end
        if (isQuarterEnd && requiredProvision > 0) {
            const glCreditCode = NPA_PROVISION_GL_CREDIT[newCategory];
            await postGl(
                loan.tenantId,
                "NPA_PROVISION",
                requiredProvision,
                `IRAC provision ${newCategory} (${dpd} DPD) — ${loan.loanNumber}`,
                period,
                { provisionGlCode: glCreditCode }
            );
            provisioned++;
        }

        // Post interest to suspense for NPA loans (sub_standard or worse)
        if (isNpa(newCategory) && newCategory !== "loss" && Number(loan.outstandingInterest) > 0) {
            const interestToSuspense = Number(loan.outstandingInterest);
            await postGl(
                loan.tenantId,
                "INTEREST_SUSPENSE",
                interestToSuspense,
                `Interest suspense — ${loan.loanNumber} (NPA: ${newCategory})`,
                period
            );
            await prisma.loan.update({
                where: { id: loan.id },
                data: { outstandingInterest: 0 },
            });
            suspensePosted++;
        }
    }

    return { classified, provisioned, suspensePosted, tenantId, period };
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
