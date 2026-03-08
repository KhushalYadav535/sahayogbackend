"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const gl_posting_1 = require("../../lib/gl-posting");
const coa_rules_1 = require("../../lib/coa-rules");
const npa_1 = require("../../workers/npa");
const day_end_1 = require("../../workers/day-end");
const audit_1 = require("../../db/audit");
const router = (0, express_1.Router)();
// ─── POST /api/v1/jobs/day-end ────────────────────────────────────────────────
router.post("/day-end", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        // Re-use the BullMQ worker logic directly
        const result = await (0, day_end_1.processDayEnd)({ data: { tenantId } });
        res.json({
            success: true,
            message: "Day-end processing complete",
            ...result,
        });
    }
    catch (err) {
        console.error("[day-end]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/jobs/npa-check — Full IRAC classification ──────────────────
router.post("/npa-check", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        // Run full IRAC classification via the worker function
        const result = await (0, npa_1.processNpa)({ data: { tenantId } });
        res.json({
            success: true,
            message: "IRAC NPA classification complete",
            ...result,
        });
    }
    catch (err) {
        console.error("[npa-check]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/jobs/month-end/checklist ───────────────────────────────────────
router.get("/month-end/checklist", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { period } = req.query;
        const checkPeriod = period || (0, gl_posting_1.currentPeriod)();
        const [year, month] = checkPeriod.split("-").map(Number);
        const periodStart = new Date(year, month - 1, 1);
        const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);
        // ACC-006: Month-End Checklist Validation
        const checklist = {};
        // 1. All day-end processes for the month completed
        const dayEndCount = await prisma_1.default.auditLog.count({
            where: {
                tenantId,
                action: "DAY_END_COMPLETED",
                createdAt: { gte: periodStart, lte: periodEnd },
            },
        });
        const workingDays = Math.ceil((periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000));
        checklist.day_end_completed = {
            status: dayEndCount >= workingDays * 0.9 ? "complete" : "incomplete",
            details: `${dayEndCount} day-end runs completed (expected ~${workingDays} for ${checkPeriod})`,
        };
        // 2. Suspense accounts cleared
        const openSuspense = await prisma_1.default.suspenseEntry.count({
            where: {
                tenantId,
                status: { in: ["OPEN", "OVERDUE"] },
                receiptDate: { lte: periodEnd },
            },
        });
        checklist.suspense_cleared = {
            status: openSuspense === 0 ? "complete" : "incomplete",
            details: `${openSuspense} suspense entries still open`,
        };
        // 3. SB interest credited (if monthly crediting)
        const sbInterestCredited = await prisma_1.default.glEntry.count({
            where: {
                tenantId,
                glCode: { startsWith: "02-01-0004" }, // SB Interest Accrued
                period: checkPeriod,
            },
        });
        checklist.sb_interest_credited = {
            status: sbInterestCredited > 0 ? "complete" : "not_applicable",
            details: sbInterestCredited > 0 ? "SB interest accruals posted" : "Monthly crediting not configured",
        };
        // 4. TDS computed and liability posted
        const tdsPosted = await prisma_1.default.glEntry.count({
            where: {
                tenantId,
                glCode: { startsWith: "04-01-0001" }, // TDS Payable
                period: checkPeriod,
            },
        });
        checklist.tds_posted = {
            status: tdsPosted > 0 ? "complete" : "incomplete",
            details: tdsPosted > 0 ? "TDS liability entries posted" : "No TDS entries found",
        };
        // 5. Loan loss provision entries posted
        const provisionPosted = await prisma_1.default.glEntry.count({
            where: {
                tenantId,
                glCode: { startsWith: "13-02-0005" }, // Provision for Bad Debts
                period: checkPeriod,
            },
        });
        checklist.provision_posted = {
            status: provisionPosted > 0 ? "complete" : "incomplete",
            details: provisionPosted > 0 ? "NPA provision entries posted" : "No provision entries found",
        };
        // 6. Bank reconciliation completed
        const bankReconUploads = await prisma_1.default.bankStatementUpload.count({
            where: {
                tenantId,
                periodStart: { lte: periodEnd },
                periodEnd: { gte: periodStart },
            },
        });
        checklist.bank_recon_completed = {
            status: bankReconUploads > 0 ? "complete" : "not_applicable",
            details: bankReconUploads > 0 ? "Bank reconciliation uploads found" : "No bank statements uploaded",
        };
        // 7. All pending maker-checker items resolved
        const pendingVouchers = await prisma_1.default.voucher.count({
            where: {
                tenantId,
                status: "pending",
                date: { gte: periodStart, lte: periodEnd },
            },
        });
        checklist.pending_items_resolved = {
            status: pendingVouchers === 0 ? "complete" : "incomplete",
            details: `${pendingVouchers} pending vouchers require approval`,
        };
        // 8. Month-end trial balance reviewed and frozen
        const tenant = await prisma_1.default.tenant.findUnique({ where: { id: tenantId } });
        const isPeriodClosed = tenant?.closedPeriods?.includes(checkPeriod) || false;
        checklist.trial_balance_frozen = {
            status: isPeriodClosed ? "complete" : "incomplete",
            details: isPeriodClosed ? "Period trial balance frozen" : "Trial balance not yet frozen",
        };
        const allComplete = Object.values(checklist).every((item) => item.status === "complete" || item.status === "not_applicable");
        res.json({
            success: true,
            period: checkPeriod,
            checklist,
            allComplete,
            canClose: allComplete,
        });
    }
    catch (err) {
        console.error("[month-end-checklist]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/jobs/month-end ──────────────────────────────────────────────
router.post("/month-end", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        const { period, force } = req.body;
        const checkPeriod = period || (0, gl_posting_1.currentPeriod)();
        // Validate checklist unless forced
        if (!force) {
            const [year, month] = checkPeriod.split("-").map(Number);
            const periodStart = new Date(year, month - 1, 1);
            const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);
            // Quick validation checks
            const openSuspense = await prisma_1.default.suspenseEntry.count({
                where: {
                    tenantId,
                    status: { in: ["OPEN", "OVERDUE"] },
                    receiptDate: { lte: periodEnd },
                },
            });
            const pendingVouchers = await prisma_1.default.voucher.count({
                where: {
                    tenantId,
                    status: "pending",
                    date: { gte: periodStart, lte: periodEnd },
                },
            });
            if (openSuspense > 0 || pendingVouchers > 0) {
                res.status(400).json({
                    success: false,
                    message: "Month-end checklist incomplete",
                    details: {
                        suspenseEntries: openSuspense,
                        pendingVouchers,
                    },
                });
                return;
            }
        }
        // Run IRAC classification on month-end
        const npaResult = await (0, npa_1.processNpa)({ data: { tenantId } });
        res.json({
            success: true,
            message: "Month-end processing complete",
            npa: npaResult,
            period: checkPeriod,
        });
    }
    catch (err) {
        console.error("[month-end]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/jobs/month-end/close ────────────────────────────────────────
router.post("/month-end/close", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin", "president"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        const { period, approvedBy } = zod_1.z.object({
            period: zod_1.z.string().regex(/^\d{4}-\d{2}$/),
            approvedBy: zod_1.z.string().min(1),
        }).parse(req.body);
        // Validate checklist
        const [year, month] = period.split("-").map(Number);
        const periodStart = new Date(year, month - 1, 1);
        const periodEnd = new Date(year, month, 0, 23, 59, 59, 999);
        const openSuspense = await prisma_1.default.suspenseEntry.count({
            where: {
                tenantId,
                status: { in: ["OPEN", "OVERDUE"] },
                receiptDate: { lte: periodEnd },
            },
        });
        const pendingVouchers = await prisma_1.default.voucher.count({
            where: {
                tenantId,
                status: "pending",
                date: { gte: periodStart, lte: periodEnd },
            },
        });
        if (openSuspense > 0 || pendingVouchers > 0) {
            res.status(400).json({
                success: false,
                message: "Cannot close month: checklist incomplete",
                details: {
                    suspenseEntries: openSuspense,
                    pendingVouchers,
                },
            });
            return;
        }
        // Mark period as closed
        const tenant = await prisma_1.default.tenant.findUnique({ where: { id: tenantId } });
        const closedPeriods = [...(tenant?.closedPeriods || []), period];
        await prisma_1.default.tenant.update({
            where: { id: tenantId },
            data: { closedPeriods },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "MONTH_END_CLOSED",
            entity: "Period",
            entityId: period,
            newData: { period, approvedBy, closedAt: new Date().toISOString() },
        });
        res.json({
            success: true,
            message: `Period ${period} closed successfully`,
            period,
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[month-end-close]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/jobs/fy-close — FY-close: statutory reserve + NCCT ────────
router.post("/fy-close", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        const period = (0, gl_posting_1.currentPeriod)();
        const { netSurplus } = zod_1.z.object({
            netSurplus: zod_1.z.number().positive("Net surplus must be positive for FY close"),
        }).parse(req.body);
        // COA: Statutory Reserve — 25% of net surplus (MSCS Act Sec 61)
        const statutoryReserve = Math.round(netSurplus * coa_rules_1.STATUTORY_RESERVE_RATE * 100) / 100;
        await (0, gl_posting_1.postGl)(tenantId, "STATUTORY_RESERVE", statutoryReserve, `FY-close statutory reserve (25% of ₹${netSurplus})`, period);
        // COA: NCCT Fund — 1% of net profit (MSCS Act Sec 62)
        const ncctFund = Math.round(netSurplus * coa_rules_1.NCCT_FUND_RATE * 100) / 100;
        await (0, gl_posting_1.postGl)(tenantId, "NCCT_FUND", ncctFund, `FY-close NCCT Fund (1% of ₹${netSurplus})`, period);
        res.json({
            success: true,
            message: "FY-close processing complete",
            netSurplus,
            statutoryReserve,
            ncctFund,
            period,
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, issues: err.issues });
            return;
        }
        console.error("[fy-close]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/jobs/usage-snapshot ────────────────────────────────────────
router.post("/usage-snapshot", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const body = (req.body || {});
        const period = body.period || new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().slice(0, 7);
        const tenants = await prisma_1.default.tenant.findMany({
            where: { status: { notIn: ["offboarded"] } },
            select: { id: true },
        });
        let created = 0;
        for (const t of tenants) {
            const [memberCount, txnCount, userCount, aiInvocations, apiCalls] = await Promise.all([
                prisma_1.default.member.count({ where: { tenantId: t.id, status: "active" } }),
                prisma_1.default.transaction.count({ where: { account: { tenantId: t.id } } }),
                prisma_1.default.user.count({ where: { tenantId: t.id } }),
                // AI invocations - count from audit logs or AI service calls
                prisma_1.default.auditLog.count({
                    where: { tenantId: t.id, action: { contains: "AI" } },
                }).catch(() => 0),
                // API calls - count from audit logs
                prisma_1.default.auditLog.count({
                    where: { tenantId: t.id },
                }).catch(() => 0),
            ]);
            // Estimate storage (in MB) - approximate based on data volume
            const storageMb = Math.ceil((memberCount * 0.5 + txnCount * 0.01) / 1024); // Rough estimate
            await prisma_1.default.tenantUsageSnapshot.upsert({
                where: { tenantId_period: { tenantId: t.id, period } },
                update: {
                    activeUsersPeak: userCount,
                    memberCount,
                    txnVolume: txnCount,
                    storageMb,
                    aiInvocations,
                    apiCalls,
                },
                create: {
                    tenantId: t.id,
                    period,
                    activeUsersPeak: userCount,
                    memberCount,
                    txnVolume: txnCount,
                    storageMb,
                    aiInvocations,
                    apiCalls,
                },
            });
            created++;
        }
        res.json({ success: true, message: `Usage snapshot created for ${created} tenants`, period });
    }
    catch (err) {
        console.error("[Usage Snapshot]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/jobs/trial-expiration-check — Check and handle trial expirations
router.post("/trial-expiration-check", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const now = new Date();
        const expiredTrials = await prisma_1.default.tenant.findMany({
            where: {
                status: "trial",
                trialEndsAt: { lte: now },
            },
            select: { id: true, name: true, trialEndsAt: true },
        });
        let transitioned = 0;
        for (const tenant of expiredTrials) {
            // Transition to suspended if no payment received
            await prisma_1.default.tenant.update({
                where: { id: tenant.id },
                data: {
                    status: "suspended",
                    trialEndsAt: null, // Clear trial end date
                },
            });
            await (0, audit_1.createAuditLog)({
                userId: req.user?.userId,
                action: "TRIAL_EXPIRED",
                entity: "Tenant",
                entityId: tenant.id,
                oldData: { status: "trial", trialEndsAt: tenant.trialEndsAt },
                newData: { status: "suspended" },
                ipAddress: req.ip,
            });
            transitioned++;
        }
        res.json({
            success: true,
            message: `Checked trial expiration. ${transitioned} tenant(s) transitioned to suspended.`,
            transitioned,
        });
    }
    catch (err) {
        console.error("[Trial Expiration Check]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/jobs/deaf-alerts — Deposits approaching DEAF Transfer ────────
router.get("/deaf-alerts", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        const alertThreshold = new Date();
        alertThreshold.setFullYear(alertThreshold.getFullYear() - Math.floor(coa_rules_1.DEAF_ALERT_YEARS));
        const deafDeposits = await prisma_1.default.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                maturityDate: { lt: alertThreshold },
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } } },
        });
        res.json({ success: true, count: deafDeposits.length, deposits: deafDeposits });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/jobs/overdue-suspense — Suspense entries overdue ─────────────
router.get("/overdue-suspense", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        const suspenseMaxDays = 30;
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - suspenseMaxDays);
        const entries = await prisma_1.default.suspenseEntry.findMany({
            where: {
                tenantId,
                status: { in: ["OPEN", "OVERDUE"] },
                createdAt: { lt: threshold },
            },
            orderBy: { createdAt: "asc" },
        });
        res.json({ success: true, count: entries.length, entries });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=jobs.js.map