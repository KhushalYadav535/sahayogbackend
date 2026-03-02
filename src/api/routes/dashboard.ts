/**
 * Tenant dashboard - real stats and recent activity.
 */
import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/v1/dashboard/stats — KPIs for tenant dashboard
router.get("/stats", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const [memberCount, loansAgg, savingsAgg, depositsAgg, prevMemberCount] = await Promise.all([
            prisma.member.count({ where: { tenantId, status: "active" } }),
            prisma.loan.aggregate({
                where: { tenantId, status: { in: ["active", "npa"] }, disbursedAt: { not: null } },
                _sum: { outstandingPrincipal: true },
                _count: { id: true },
            }),
            prisma.sbAccount.aggregate({
                where: { tenantId, status: "active", accountType: "savings" },
                _sum: { balance: true },
            }),
            prisma.deposit.aggregate({
                where: { tenantId, status: "active" },
                _sum: { principal: true },
            }),
            prisma.member.count({ where: { tenantId } }), // prev month approx - we don't have historical; use same for now
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/dashboard/activity — recent SB transactions
router.get("/activity", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const limit = Math.min(parseInt((req.query.limit as string) || "10", 10), 50);
        const transactions = await prisma.transaction.findMany({
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
