/**
 * Sahayog AI — Day-End Worker (BullMQ)
 * Runs the comprehensive daily end-of-day jobs:
 *   - SB interest accrual (daily product method)
 *   - FDR/RD daily interest accrual
 *   - MIS monthly payout (1st of month)
 *   - Dormant account reclassification (24 months)
 *   - EMI overdue marking
 *   - Suspense entry age alerts
 *   - Unclaimed deposit tracking (DEAF approach)
 */
import { Worker, Job } from "bullmq";
import prisma from "../db/prisma";
import { postGl, currentPeriod } from "../lib/gl-posting";
import { DORMANCY_MONTHS, DEAF_ALERT_YEARS } from "../lib/coa-rules";

const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};

export async function processDayEnd(job: Job<{ tenantId: string }>) {
    const { tenantId } = job.data;
    const period = currentPeriod();
    const today = new Date();
    const isFirstOfMonth = today.getDate() === 1;

    // ── 1. SB Interest Accrual (daily product method) ──────────────────────
    const sbAccounts = await prisma.sbAccount.findMany({
        where: { tenantId, status: "active" },
    });

    let sbAccrualsPosted = 0;
    for (const acct of sbAccounts) {
        const dailyInterest = Math.round(
            (Number(acct.balance) * Number(acct.interestRate)) / (100 * 365) * 100
        ) / 100;
        if (dailyInterest >= 0.01) {
            // COA: Accrue to GL 02-01-0004 (SB Interest Accrued) — do NOT credit balance yet
            await postGl(tenantId, "SB_INTEREST_ACCRUAL", dailyInterest,
                `SB daily interest accrual — ${acct.accountNumber}`, period);
            sbAccrualsPosted++;
        }
    }

    // ── 2. FDR Daily Accrual → GL 02-02-0004 ───────────────────────────────
    const fdrs = await prisma.deposit.findMany({
        where: { tenantId, depositType: "fd", status: "active" },
    });

    let fdrAccrualsPosted = 0;
    for (const fdr of fdrs) {
        const dailyRate = Number(fdr.interestRate) / 100 / 365;
        const dailyInterest = Math.round(Number(fdr.principal) * dailyRate * 100) / 100;
        if (dailyInterest >= 0.01) {
            await prisma.deposit.update({
                where: { id: fdr.id },
                data: { accruedInterest: Number(fdr.accruedInterest) + dailyInterest },
            });
            await postGl(tenantId, "FDR_INTEREST_ACCRUAL", dailyInterest,
                `FDR daily interest accrual — ${fdr.depositNumber}`, period);
            fdrAccrualsPosted++;
        }
    }

    // ── 3. RD Daily Accrual ─────────────────────────────────────────────────
    const rds = await prisma.deposit.findMany({
        where: { tenantId, depositType: "rd", status: "active" },
    });

    let rdAccrualsPosted = 0;
    for (const rd of rds) {
        const dailyRate = Number(rd.interestRate) / 100 / 365;
        const balance = Number(rd.accruedInterest) + Number(rd.principal);
        const dailyInterest = Math.round(balance * dailyRate * 100) / 100;
        if (dailyInterest >= 0.01) {
            await prisma.deposit.update({
                where: { id: rd.id },
                data: { accruedInterest: Number(rd.accruedInterest) + dailyInterest },
            });
            rdAccrualsPosted++;
        }
    }

    // ── 4. MIS Monthly Payout (1st of month) →  SB account ─────────────────
    let misPayoutsPosted = 0;
    if (isFirstOfMonth) {
        const misDeposits = await prisma.deposit.findMany({
            where: { tenantId, depositType: "mis", status: "active" },
            include: { member: { include: { sbAccounts: { where: { status: "active" }, take: 1 } } } },
        });

        for (const mis of misDeposits) {
            // Monthly MIS interest = principal × rate / 12
            const monthlyInterest = Math.round(
                Number(mis.principal) * Number(mis.interestRate) / 100 / 12 * 100
            ) / 100;

            if (monthlyInterest >= 0.01) {
                const sbAccount = mis.member.sbAccounts[0];
                if (sbAccount) {
                    // Credit SB account
                    await prisma.sbAccount.update({
                        where: { id: sbAccount.id },
                        data: { balance: Number(sbAccount.balance) + monthlyInterest, lastActivityAt: today },
                    });
                    await prisma.transaction.create({
                        data: {
                            accountId: sbAccount.id,
                            type: "credit",
                            category: "interest",
                            amount: monthlyInterest,
                            balanceAfter: Number(sbAccount.balance) + monthlyInterest,
                            remarks: `MIS monthly interest — ${mis.depositNumber}`,
                        },
                    });
                }
                // GL posting
                await postGl(tenantId, "MIS_INTEREST_PAYOUT", monthlyInterest,
                    `MIS monthly payout — ${mis.depositNumber}`, period);
                misPayoutsPosted++;
            }
        }
    }

    // ── 5. EMI Overdue Marking ──────────────────────────────────────────────
    const overdueEmis = await prisma.emiSchedule.updateMany({
        where: {
            dueDate: { lt: today },
            status: "pending",
            loan: { tenantId },
        },
        data: { status: "overdue" },
    });

    // ── 6. Dormant SB Account Reclassification (24 months) ─────────────────
    const dormancyThreshold = new Date();
    dormancyThreshold.setMonth(dormancyThreshold.getMonth() - DORMANCY_MONTHS);

    const dormantUpdate = await prisma.sbAccount.updateMany({
        where: {
            tenantId,
            status: "active",
            OR: [
                { lastActivityAt: { lt: dormancyThreshold } },
                { lastActivityAt: null },
            ],
        },
        data: { status: "dormant", kycRefreshRequired: true },
    });

    // ── 7. Suspense Alerts — OPEN entries older than configured days ─────────
    const suspenseMaxDays = 30; // configurable
    const suspenseThreshold = new Date();
    suspenseThreshold.setDate(suspenseThreshold.getDate() - suspenseMaxDays);

    const overdueSuspense = await prisma.suspenseEntry.count({
        where: {
            tenantId,
            status: "OPEN",
            createdAt: { lt: suspenseThreshold },
        },
    });

    if (overdueSuspense > 0) {
        // Mark as OVERDUE
        await prisma.suspenseEntry.updateMany({
            where: {
                tenantId,
                status: "OPEN",
                createdAt: { lt: suspenseThreshold },
            },
            data: { status: "OVERDUE" },
        });
    }

    // ── 8. DEAF Alert — Deposits near 10-year unclaimed threshold ───────────
    const deafAlertThreshold = new Date();
    deafAlertThreshold.setFullYear(deafAlertThreshold.getFullYear() - Math.floor(DEAF_ALERT_YEARS));

    const deafApproaching = await prisma.deposit.count({
        where: {
            tenantId,
            status: "active",
            maturityDate: { lt: deafAlertThreshold },
        },
    });

    return {
        tenantId,
        period,
        sbAccrualsPosted,
        fdrAccrualsPosted,
        rdAccrualsPosted,
        misPayoutsPosted,
        overdueEmisMarked: overdueEmis.count,
        dormantAccountsMarked: dormantUpdate.count,
        overdueSuspenseAlerts: overdueSuspense,
        deafApproachingDeposits: deafApproaching,
    };
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
