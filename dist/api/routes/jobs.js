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
// ─── POST /api/v1/jobs/month-end ──────────────────────────────────────────────
router.post("/month-end", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        // Run IRAC classification on month-end
        const npaResult = await (0, npa_1.processNpa)({ data: { tenantId } });
        res.json({
            success: true,
            message: "Month-end processing complete",
            npa: npaResult,
        });
    }
    catch (err) {
        console.error("[month-end]", err);
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
            const [memberCount, txnCount, userCount] = await Promise.all([
                prisma_1.default.member.count({ where: { tenantId: t.id, status: "active" } }),
                prisma_1.default.transaction.count({ where: { account: { tenantId: t.id } } }),
                prisma_1.default.user.count({ where: { tenantId: t.id } }),
            ]);
            await prisma_1.default.tenantUsageSnapshot.upsert({
                where: { tenantId_period: { tenantId: t.id, period } },
                update: {
                    activeUsersPeak: userCount,
                    memberCount,
                    txnVolume: txnCount,
                },
                create: {
                    tenantId: t.id,
                    period,
                    activeUsersPeak: userCount,
                    memberCount,
                    txnVolume: txnCount,
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