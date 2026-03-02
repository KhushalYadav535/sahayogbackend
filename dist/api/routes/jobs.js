"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// POST /api/v1/jobs/day-end — trigger day-end processing manually
router.post("/day-end", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        // Apply daily interest to all active SB accounts
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
                            remarks: "Daily interest",
                        },
                    }),
                ]);
                processed++;
            }
        }
        // Mark overdue EMIs
        const overdueEmis = await prisma_1.default.emiSchedule.updateMany({
            where: {
                dueDate: { lt: new Date() },
                status: "pending",
                loan: { tenantId },
            },
            data: { status: "overdue" },
        });
        // SB-005: Mark dormant accounts (no activity for 24 months)
        const dormancyThreshold = new Date();
        dormancyThreshold.setMonth(dormancyThreshold.getMonth() - 24);
        const dormantUpdate = await prisma_1.default.sbAccount.updateMany({
            where: {
                tenantId,
                status: "active",
                OR: [
                    { lastActivityAt: { lt: dormancyThreshold } },
                    { lastActivityAt: null },
                ],
            },
            data: { status: "dormant" },
        });
        res.json({
            success: true,
            message: "Day-end processing complete",
            sbAccountsProcessed: processed,
            overdueEmisMarked: overdueEmis.count,
            dormantAccountsMarked: dormantUpdate.count,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/jobs/month-end
router.post("/month-end", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        // Mark NPA loans (90+ days overdue)
        const npaThreshold = new Date();
        npaThreshold.setDate(npaThreshold.getDate() - 90);
        const npaLoans = await prisma_1.default.loan.findMany({
            where: {
                tenantId,
                status: "active",
                emiSchedule: {
                    some: {
                        status: "overdue",
                        dueDate: { lt: npaThreshold },
                    },
                },
            },
        });
        let npaMarked = 0;
        for (const loan of npaLoans) {
            await prisma_1.default.loan.update({
                where: { id: loan.id },
                data: { status: "npa", npaDate: new Date(), npaCategory: "sub_standard" }, // LN-011: 90-day NPA -> Sub-Standard
            });
            npaMarked++;
        }
        res.json({
            success: true,
            message: "Month-end processing complete",
            npaLoansMarked: npaMarked,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/jobs/usage-snapshot — aggregate usage for all tenants (super admin only, MT-005)
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
// POST /api/v1/jobs/npa-check
router.post("/npa-check", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenantId = req.user?.tenantId;
        const npaThreshold = new Date();
        npaThreshold.setDate(npaThreshold.getDate() - 90);
        const npaLoans = await prisma_1.default.loan.findMany({
            where: {
                tenantId: tenantId ?? undefined,
                status: "active",
                emiSchedule: { some: { status: "overdue", dueDate: { lt: npaThreshold } } },
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });
        res.json({ success: true, npaLoans, count: npaLoans.length });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=jobs.js.map