"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDayEnd = processDayEnd;
exports.startDayEndWorker = startDayEndWorker;
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
const bullmq_1 = require("bullmq");
const prisma_1 = __importDefault(require("../db/prisma"));
const gl_posting_1 = require("../lib/gl-posting");
const coa_rules_1 = require("../lib/coa-rules");
const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};
async function processDayEnd(job) {
    const { tenantId } = job.data;
    const period = (0, gl_posting_1.currentPeriod)();
    const today = new Date();
    const isFirstOfMonth = today.getDate() === 1;
    // ── 1. SB Interest Accrual (daily product method) ──────────────────────
    const sbAccounts = await prisma_1.default.sbAccount.findMany({
        where: { tenantId, status: "active" },
        include: { member: true },
    });
    let sbAccrualsPosted = 0;
    let sweepInsExecuted = 0;
    let sweepOutsExecuted = 0;
    for (const acct of sbAccounts) {
        const balance = Number(acct.balance);
        // DEP-016 / SB-009: Sweep-In — Transfer excess SB balance to FDR
        if (balance > coa_rules_1.SWEEP_IN_THRESHOLD) {
            const excessAmount = balance - coa_rules_1.SWEEP_IN_THRESHOLD;
            // Find existing sweep FDR for this account or create new
            const existingSweepFdr = await prisma_1.default.deposit.findFirst({
                where: {
                    tenantId,
                    memberId: acct.memberId,
                    depositType: "fd",
                    status: "active",
                    // Mark sweep FDRs with a special pattern or add a flag
                    // For now, we'll create a new short-term FDR
                },
                orderBy: { openedAt: "desc" },
            });
            if (!existingSweepFdr || (existingSweepFdr && Number(existingSweepFdr.principal) < excessAmount)) {
                // Create new sweep FDR
                const count = await prisma_1.default.deposit.count({ where: { tenantId } });
                const depositNumber = `FD${String(count + 1).padStart(8, "0")}`;
                const sweepMaturityDate = new Date(today);
                sweepMaturityDate.setMonth(sweepMaturityDate.getMonth() + coa_rules_1.SWEEP_FDR_TENURE_MONTHS);
                // Get FDR rate for short tenure (1-3 months)
                const sweepRate = 6.5; // Default rate for 1-3 months
                const sweepFdr = await prisma_1.default.deposit.create({
                    data: {
                        tenantId,
                        memberId: acct.memberId,
                        depositNumber,
                        depositType: "fd",
                        principal: excessAmount,
                        interestRate: sweepRate,
                        tenureMonths: coa_rules_1.SWEEP_FDR_TENURE_MONTHS,
                        compoundingFreq: "quarterly",
                        maturityDate: sweepMaturityDate,
                        status: "active",
                        isSeniorCitizen: false,
                        accruedInterest: 0,
                    },
                });
                // Debit SB account
                await prisma_1.default.sbAccount.update({
                    where: { id: acct.id },
                    data: { balance: coa_rules_1.SWEEP_IN_THRESHOLD, lastActivityAt: today },
                });
                await prisma_1.default.transaction.create({
                    data: {
                        accountId: acct.id,
                        type: "debit",
                        category: "transfer",
                        amount: excessAmount,
                        balanceAfter: coa_rules_1.SWEEP_IN_THRESHOLD,
                        remarks: `Sweep-in to FDR — ${depositNumber}`,
                    },
                });
                // GL posting
                await (0, gl_posting_1.postGl)(tenantId, "FDR_OPEN", excessAmount, `Sweep-in FDR created — ${depositNumber}`, period);
                sweepInsExecuted++;
            }
        }
        // DEP-016 / SB-009: Sweep-Out — Break FDR to top up SB if balance low
        if (balance < coa_rules_1.SWEEP_OUT_THRESHOLD) {
            const shortfall = coa_rules_1.SWEEP_OUT_THRESHOLD - balance;
            // Find active FDRs for this member (prefer sweep FDRs or short-term)
            const availableFdrs = await prisma_1.default.deposit.findMany({
                where: {
                    tenantId,
                    memberId: acct.memberId,
                    depositType: "fd",
                    status: "active",
                    lienLoanId: null, // No lien
                },
                orderBy: { openedAt: "asc" }, // Oldest first
            });
            for (const fdr of availableFdrs) {
                const fdrPrincipal = Number(fdr.principal);
                if (fdrPrincipal >= shortfall) {
                    // Break FDR partially or fully
                    const holdingMonths = Math.floor((today.getTime() - fdr.openedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
                    // Calculate interest on actual holding period (penalty waived for sweep-out)
                    const actualRate = Number(fdr.interestRate) / 100;
                    const interestEarned = Math.round(fdrPrincipal * actualRate * (holdingMonths / 12) * 100) / 100;
                    const totalPayable = fdrPrincipal + interestEarned;
                    const amountToTransfer = Math.min(totalPayable, shortfall + 1000); // Add buffer
                    // Update SB balance
                    const newSbBalance = balance + amountToTransfer;
                    await prisma_1.default.sbAccount.update({
                        where: { id: acct.id },
                        data: { balance: newSbBalance, lastActivityAt: today },
                    });
                    await prisma_1.default.transaction.create({
                        data: {
                            accountId: acct.id,
                            type: "credit",
                            category: "transfer",
                            amount: amountToTransfer,
                            balanceAfter: newSbBalance,
                            remarks: `Sweep-out from FDR — ${fdr.depositNumber}`,
                        },
                    });
                    // Close or reduce FDR
                    if (amountToTransfer >= totalPayable) {
                        // Fully close FDR
                        await prisma_1.default.deposit.update({
                            where: { id: fdr.id },
                            data: {
                                status: "prematurely_closed",
                                closedAt: today,
                                principal: 0,
                            },
                        });
                    }
                    else {
                        // Partial withdrawal (reduce principal)
                        const remainingPrincipal = fdrPrincipal - amountToTransfer;
                        await prisma_1.default.deposit.update({
                            where: { id: fdr.id },
                            data: { principal: remainingPrincipal },
                        });
                    }
                    // GL posting
                    await (0, gl_posting_1.postGl)(tenantId, "FDR_MATURE", amountToTransfer, `Sweep-out FDR closure — ${fdr.depositNumber}`, period);
                    sweepOutsExecuted++;
                    break; // One sweep-out per account per day
                }
            }
        }
        // Daily interest accrual
        const dailyInterest = Math.round((balance * Number(acct.interestRate)) / (100 * 365) * 100) / 100;
        if (dailyInterest >= 0.01) {
            // COA: Accrue to GL 02-01-0004 (SB Interest Accrued) — do NOT credit balance yet
            await (0, gl_posting_1.postGl)(tenantId, "SB_INTEREST_ACCRUAL", dailyInterest, `SB daily interest accrual — ${acct.accountNumber}`, period);
            sbAccrualsPosted++;
        }
    }
    // ── 2. FDR Daily Accrual → GL 02-02-0004 ───────────────────────────────
    const fdrs = await prisma_1.default.deposit.findMany({
        where: { tenantId, depositType: "fd", status: "active" },
    });
    let fdrAccrualsPosted = 0;
    for (const fdr of fdrs) {
        // DEP-003: Configurable compounding frequency handling
        // For daily accrual, we use simple interest calculation
        // Compounding is applied at maturity or when interest is credited
        const dailyRate = Number(fdr.interestRate) / 100 / 365;
        const dailyInterest = Math.round(Number(fdr.principal) * dailyRate * 100) / 100;
        if (dailyInterest >= 0.01) {
            await prisma_1.default.deposit.update({
                where: { id: fdr.id },
                data: { accruedInterest: Number(fdr.accruedInterest) + dailyInterest },
            });
            await (0, gl_posting_1.postGl)(tenantId, "FDR_INTEREST_ACCRUAL", dailyInterest, `FDR daily interest accrual — ${fdr.depositNumber}`, period);
            fdrAccrualsPosted++;
        }
    }
    // ── 3. RD Daily Accrual & Monthly Installment Collection ────────────────
    const rds = await prisma_1.default.deposit.findMany({
        where: { tenantId, depositType: "rd", status: "active" },
        include: { member: { include: { sbAccounts: { where: { status: "active" }, take: 1 } } } },
    });
    let rdAccrualsPosted = 0;
    let rdInstallmentsCollected = 0;
    let rdInstallmentsMissed = 0;
    for (const rd of rds) {
        // Calculate months since RD opened
        const monthsSinceOpened = Math.floor((today.getTime() - rd.openedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
        const expectedInstallments = Math.min(monthsSinceOpened + 1, rd.tenureMonths);
        // Calculate expected principal if all installments were paid
        const expectedPrincipal = Number(rd.rdMonthlyAmount || 0) * expectedInstallments;
        const currentPrincipal = Number(rd.principal);
        const installmentDue = Number(rd.rdMonthlyAmount || 0);
        // Check if today is installment due date (same day of month as opened)
        const isInstallmentDueDate = today.getDate() === rd.openedAt.getDate() &&
            currentPrincipal < expectedPrincipal &&
            monthsSinceOpened < rd.tenureMonths;
        if (isInstallmentDueDate) {
            // DEP-008: RD Installment Collection
            const sbAccount = rd.member.sbAccounts[0];
            if (sbAccount && Number(sbAccount.balance) >= installmentDue) {
                // Collect installment from SB account
                const newSbBalance = Number(sbAccount.balance) - installmentDue;
                await prisma_1.default.sbAccount.update({
                    where: { id: sbAccount.id },
                    data: {
                        balance: newSbBalance,
                        lastActivityAt: today
                    },
                });
                // Create transaction record
                await prisma_1.default.transaction.create({
                    data: {
                        accountId: sbAccount.id,
                        type: "debit",
                        category: "deposit",
                        amount: installmentDue,
                        balanceAfter: newSbBalance,
                        remarks: `RD installment — ${rd.depositNumber}`,
                    },
                });
                // Update RD principal
                const newPrincipal = currentPrincipal + installmentDue;
                await prisma_1.default.deposit.update({
                    where: { id: rd.id },
                    data: { principal: newPrincipal },
                });
                // GL posting: DR SB Account, CR RD Liability
                await (0, gl_posting_1.postGl)(tenantId, "RD_INSTALLMENT_COLLECTED", installmentDue, `RD installment collected — ${rd.depositNumber}`, period);
                rdInstallmentsCollected++;
            }
            else {
                // Missed installment - mark for tracking
                rdInstallmentsMissed++;
                // TODO: Send alert to member about missed installment
            }
        }
        // Daily interest accrual on current balance
        const dailyRate = Number(rd.interestRate) / 100 / 365;
        const balance = Number(rd.accruedInterest) + Number(rd.principal);
        const dailyInterest = Math.round(balance * dailyRate * 100) / 100;
        if (dailyInterest >= 0.01) {
            await prisma_1.default.deposit.update({
                where: { id: rd.id },
                data: { accruedInterest: Number(rd.accruedInterest) + dailyInterest },
            });
            await (0, gl_posting_1.postGl)(tenantId, "RD_INTEREST_ACCRUAL", dailyInterest, `RD daily interest accrual — ${rd.depositNumber}`, period);
            rdAccrualsPosted++;
        }
    }
    // ── 4. MIS Monthly Payout (1st of month) →  SB account ─────────────────
    let misPayoutsPosted = 0;
    if (isFirstOfMonth) {
        const misDeposits = await prisma_1.default.deposit.findMany({
            where: { tenantId, depositType: "mis", status: "active" },
            include: { member: { include: { sbAccounts: { where: { status: "active" }, take: 1 } } } },
        });
        for (const mis of misDeposits) {
            // Monthly MIS interest = principal × rate / 12
            const monthlyInterest = Math.round(Number(mis.principal) * Number(mis.interestRate) / 100 / 12 * 100) / 100;
            if (monthlyInterest >= 0.01) {
                const sbAccount = mis.member.sbAccounts[0];
                if (sbAccount) {
                    // Credit SB account
                    await prisma_1.default.sbAccount.update({
                        where: { id: sbAccount.id },
                        data: { balance: Number(sbAccount.balance) + monthlyInterest, lastActivityAt: today },
                    });
                    await prisma_1.default.transaction.create({
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
                await (0, gl_posting_1.postGl)(tenantId, "MIS_INTEREST_PAYOUT", monthlyInterest, `MIS monthly payout — ${mis.depositNumber}`, period);
                misPayoutsPosted++;
            }
        }
    }
    // ── 5. EMI Overdue Marking & LN-005: Pre-EMI Collection (Moratorium) ─────
    const overdueEmis = await prisma_1.default.emiSchedule.updateMany({
        where: {
            dueDate: { lt: today },
            status: "pending",
            loan: { tenantId },
        },
        data: { status: "overdue" },
    });
    // LN-005: Collect pre-EMI interest during moratorium period
    const loansInMoratorium = await prisma_1.default.loan.findMany({
        where: {
            tenantId,
            status: "active",
            moratoriumEndDate: { gte: today },
            OR: [
                { moratoriumEndDate: null },
                { moratoriumEndDate: { gte: today } },
            ],
        },
        include: { member: { include: { sbAccounts: { where: { status: "active" }, take: 1 } } } },
    });
    let preEmiCollected = 0;
    for (const loan of loansInMoratorium) {
        if (!loan.moratoriumEndDate || new Date(loan.moratoriumEndDate) >= today) {
            const outstandingPrincipal = Number(loan.outstandingPrincipal);
            const preEmiRate = Number(loan.interestRate) / 100; // Same as loan rate (loan.pre_emi.rate)
            const preEmiInterest = Math.round((outstandingPrincipal * preEmiRate / 12) * 100) / 100;
            if (preEmiInterest >= 0.01 && loan.member.sbAccounts[0]) {
                const sbAccount = loan.member.sbAccounts[0];
                const newBalance = Number(sbAccount.balance) - preEmiInterest;
                if (newBalance >= 0) {
                    await prisma_1.default.$transaction([
                        prisma_1.default.sbAccount.update({
                            where: { id: sbAccount.id },
                            data: { balance: newBalance, lastActivityAt: today },
                        }),
                        prisma_1.default.transaction.create({
                            data: {
                                accountId: sbAccount.id,
                                type: "debit",
                                category: "loan_emi",
                                amount: preEmiInterest,
                                balanceAfter: newBalance,
                                remarks: `Pre-EMI interest — ${loan.loanNumber}`,
                            },
                        }),
                    ]);
                    // GL: DR SB Account, CR Pre-EMI Interest Income
                    await (0, gl_posting_1.postGl)(tenantId, "LOAN_REPAYMENT_INTEREST", preEmiInterest, `Pre-EMI interest collection — ${loan.loanNumber}`, period);
                    preEmiCollected++;
                }
            }
        }
    }
    // ── 6. Dormant SB Account Reclassification (24 months) ─────────────────
    const dormancyThreshold = new Date();
    dormancyThreshold.setMonth(dormancyThreshold.getMonth() - coa_rules_1.DORMANCY_MONTHS);
    const dormantUpdate = await prisma_1.default.sbAccount.updateMany({
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
    const overdueSuspense = await prisma_1.default.suspenseEntry.count({
        where: {
            tenantId,
            status: "OPEN",
            createdAt: { lt: suspenseThreshold },
        },
    });
    if (overdueSuspense > 0) {
        // Mark as OVERDUE
        await prisma_1.default.suspenseEntry.updateMany({
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
    deafAlertThreshold.setFullYear(deafAlertThreshold.getFullYear() - Math.floor(coa_rules_1.DEAF_ALERT_YEARS));
    const deafApproaching = await prisma_1.default.deposit.count({
        where: {
            tenantId,
            status: "active",
            maturityDate: { lt: deafAlertThreshold },
        },
    });
    // ── GOV-001: BOD Term Expiry Alerts (T-60 and T-30 days) ───────────────────
    const t60Start = new Date(today);
    t60Start.setDate(t60Start.getDate() + 59);
    const t60End = new Date(today);
    t60End.setDate(t60End.getDate() + 61);
    const t30Start = new Date(today);
    t30Start.setDate(t30Start.getDate() + 29);
    const t30End = new Date(today);
    t30End.setDate(t30End.getDate() + 31);
    const expiringDirectors = await prisma_1.default.bodDirector.findMany({
        where: {
            tenantId,
            status: "active",
            OR: [
                { termEnd: { gte: t30Start, lte: t30End } },
                { termEnd: { gte: t60Start, lte: t60End } },
            ],
        },
    });
    // ── GOV-007: Action Item Escalation ────────────────────────────────────────
    const overdueActionItems = await prisma_1.default.meetingMinutes.findMany({
        where: {
            tenantId,
            minutesType: "FINALIZED",
            actionItems: { not: null },
        },
    });
    let escalatedActionItems = 0;
    for (const minutes of overdueActionItems) {
        const actionItems = minutes.actionItems;
        if (!actionItems)
            continue;
        const updatedItems = actionItems.map((item) => {
            if (item.status === "OPEN" || item.status === "IN_PROGRESS") {
                const dueDate = new Date(item.dueDate);
                if (dueDate < today) {
                    escalatedActionItems++;
                    return { ...item, status: "OVERDUE" };
                }
            }
            return item;
        });
        if (escalatedActionItems > 0) {
            await prisma_1.default.meetingMinutes.update({
                where: { id: minutes.id },
                data: { actionItems: updatedItems },
            });
        }
    }
    return {
        tenantId,
        period,
        sbAccrualsPosted,
        fdrAccrualsPosted,
        rdAccrualsPosted,
        rdInstallmentsCollected,
        rdInstallmentsMissed,
        misPayoutsPosted,
        sweepInsExecuted,
        sweepOutsExecuted,
        overdueEmisMarked: overdueEmis.count,
        dormantAccountsMarked: dormantUpdate.count,
        overdueSuspenseAlerts: overdueSuspense,
        deafApproachingDeposits: deafApproaching,
        bodAlertsSent: expiringDirectors.length,
        actionItemsEscalated: escalatedActionItems,
    };
}
function startDayEndWorker() {
    const worker = new bullmq_1.Worker("day-end", async (job) => processDayEnd(job), { connection });
    worker.on("completed", (job) => console.log(`[day-end] Job ${job.id} completed`));
    worker.on("failed", (job, err) => console.error(`[day-end] Job ${job?.id} failed:`, err));
    return worker;
}
//# sourceMappingURL=day-end.js.map