"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processNpa = processNpa;
exports.startNpaWorker = startNpaWorker;
/**
 * Sahayog AI — NPA Worker
 * Full IRAC classification per RBI norms.
 * Runs daily via BullMQ; also callable from jobs.ts.
 */
const bullmq_1 = require("bullmq");
const prisma_1 = __importDefault(require("../db/prisma"));
const gl_posting_1 = require("../lib/gl-posting");
const coa_rules_1 = require("../lib/coa-rules");
const connection = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
};
/** Compute days past due from oldest overdue EMI */
function computeDpd(oldestOverdueDueDate) {
    if (!oldestOverdueDueDate)
        return 0;
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
async function processNpa(job) {
    const tenantId = job.data.tenantId;
    const period = (0, gl_posting_1.currentPeriod)();
    const now = new Date();
    const isQuarterEnd = [3, 6, 9, 12].includes(now.getMonth() + 1) && now.getDate() === new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const where = {
        status: { in: ["active", "npa"] },
    };
    if (tenantId)
        where.tenantId = tenantId;
    const loans = await prisma_1.default.loan.findMany({
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
        const prevCategory = (loan.npaCategory ?? "standard");
        // If manually marked as loss, don't auto-downgrade
        let newCategory = loan.npaCategory === "loss" ? "loss" : (0, coa_rules_1.getNpaCategory)(dpd);
        const outstanding = Number(loan.outstandingPrincipal);
        const provisionRate = coa_rules_1.NPA_PROVISION_RATES[newCategory];
        const requiredProvision = Math.round(outstanding * provisionRate * 100) / 100;
        const updates = {
            npaCategory: newCategory,
            npaDpd: dpd,
            npaProvision: requiredProvision,
        };
        // If entering NPA for the first time
        if ((0, coa_rules_1.isNpa)(newCategory) && !(0, coa_rules_1.isNpa)(prevCategory)) {
            updates.npaDate = new Date();
            updates.status = "npa";
        }
        // If cured from NPA back to standard
        if (!(0, coa_rules_1.isNpa)(newCategory) && (0, coa_rules_1.isNpa)(prevCategory)) {
            updates.status = "active";
            updates.npaDate = null;
            // Post provision reversal
            const prevProvision = Number(loan.npaProvision ?? 0);
            if (prevProvision > 0) {
                const prevGlCode = coa_rules_1.NPA_PROVISION_GL_CREDIT[prevCategory];
                await (0, gl_posting_1.postGl)(loan.tenantId, "NPA_PROVISION_REVERSAL", prevProvision, `Provision reversal — ${loan.loanNumber} cured to ${newCategory}`, period, { provisionGlCode: prevGlCode });
            }
        }
        await prisma_1.default.loan.update({ where: { id: loan.id }, data: updates });
        classified++;
        // Post quarterly provision GL on quarter-end
        if (isQuarterEnd && requiredProvision > 0) {
            const glCreditCode = coa_rules_1.NPA_PROVISION_GL_CREDIT[newCategory];
            await (0, gl_posting_1.postGl)(loan.tenantId, "NPA_PROVISION", requiredProvision, `IRAC provision ${newCategory} (${dpd} DPD) — ${loan.loanNumber}`, period, { provisionGlCode: glCreditCode });
            provisioned++;
        }
        // Post interest to suspense for NPA loans (sub_standard or worse)
        if ((0, coa_rules_1.isNpa)(newCategory) && newCategory !== "loss" && Number(loan.outstandingInterest) > 0) {
            const interestToSuspense = Number(loan.outstandingInterest);
            await (0, gl_posting_1.postGl)(loan.tenantId, "INTEREST_SUSPENSE", interestToSuspense, `Interest suspense — ${loan.loanNumber} (NPA: ${newCategory})`, period);
            await prisma_1.default.loan.update({
                where: { id: loan.id },
                data: { outstandingInterest: 0 },
            });
            suspensePosted++;
        }
    }
    return { classified, provisioned, suspensePosted, tenantId, period };
}
function startNpaWorker() {
    const worker = new bullmq_1.Worker("npa", async (job) => processNpa(job), { connection });
    worker.on("completed", (job) => console.log(`[npa] Job ${job.id} completed`));
    worker.on("failed", (job, err) => console.error(`[npa] Job ${job?.id} failed:`, err));
    return worker;
}
//# sourceMappingURL=npa.js.map