"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tenant dashboard - real stats and recent activity.
 */
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// GET /api/v1/dashboard/stats — KPIs for tenant dashboard
router.get("/stats", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const [memberCount, loansAgg, savingsAgg, depositsAgg, prevMemberCount] = await Promise.all([
            prisma_1.default.member.count({ where: { tenantId, status: "active" } }),
            prisma_1.default.loan.aggregate({
                where: { tenantId, status: { in: ["active", "npa"] }, disbursedAt: { not: null } },
                _sum: { outstandingPrincipal: true },
                _count: { id: true },
            }),
            prisma_1.default.sbAccount.aggregate({
                where: { tenantId, status: "active", accountType: "savings" },
                _sum: { balance: true },
            }),
            prisma_1.default.deposit.aggregate({
                where: { tenantId, status: "active" },
                _sum: { principal: true },
            }),
            prisma_1.default.member.count({ where: { tenantId } }), // prev month approx - we don't have historical; use same for now
        ]);
        const activeLoansOutstanding = Number(loansAgg._sum.outstandingPrincipal ?? 0);
        const totalSavings = Number(savingsAgg._sum.balance ?? 0);
        const totalDeposits = Number(depositsAgg._sum.principal ?? 0);
        res.json({
            success: true,
            stats: {
                memberCount,
                activeLoansOutstanding,
                activeLoansCount: loansAgg._count.id,
                totalSavings,
                totalDeposits,
                memberChangePercent: prevMemberCount > 0 ? 0 : 0, // No historical; could add TenantUsageSnapshot
            },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/dashboard/activity — recent SB transactions
router.get("/activity", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);
        const transactions = await prisma_1.default.transaction.findMany({
            where: { account: { tenantId } },
            take: limit,
            orderBy: { processedAt: "desc" },
            include: {
                account: {
                    include: { member: { select: { firstName: true, lastName: true } } },
                },
            },
        });
        const activities = transactions.map((t) => ({
            id: t.id,
            type: t.type,
            category: t.category,
            amount: Number(t.amount),
            memberName: t.account.member ? `${t.account.member.firstName} ${t.account.member.lastName}`.trim() : "—",
            processedAt: t.processedAt,
            remarks: t.remarks,
        }));
        res.json({ success: true, activities });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=dashboard.js.map