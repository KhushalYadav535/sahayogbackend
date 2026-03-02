import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

// POST /api/v1/jobs/day-end — trigger day-end processing manually
router.post("/day-end", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }

        // Apply daily interest to all active SB accounts
        const accounts = await prisma.sbAccount.findMany({
            where: { tenantId, status: "active" },
        });

        let processed = 0;
        for (const acct of accounts) {
            const dailyInterest = (Number(acct.balance) * Number(acct.interestRate)) / (100 * 365);
            if (dailyInterest > 0.01) {
                const newBalance = Number(acct.balance) + dailyInterest;
                await prisma.$transaction([
                    prisma.sbAccount.update({ where: { id: acct.id }, data: { balance: newBalance } }),
                    prisma.transaction.create({
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
        const overdueEmis = await prisma.emiSchedule.updateMany({
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
        const dormantUpdate = await prisma.sbAccount.updateMany({
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/jobs/month-end
router.post("/month-end", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }

        // Mark NPA loans (90+ days overdue)
        const npaThreshold = new Date();
        npaThreshold.setDate(npaThreshold.getDate() - 90);

        const npaLoans = await prisma.loan.findMany({
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
            await prisma.loan.update({
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/jobs/usage-snapshot — aggregate usage for all tenants (super admin only, MT-005)
router.post("/usage-snapshot", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = (req.body || {}) as { period?: string };
        const period =
            body.period || new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().slice(0, 7);

        const tenants = await prisma.tenant.findMany({
            where: { status: { notIn: ["offboarded"] } },
            select: { id: true },
        });

        let created = 0;
        for (const t of tenants) {
            const [memberCount, txnCount, userCount] = await Promise.all([
                prisma.member.count({ where: { tenantId: t.id, status: "active" } }),
                prisma.transaction.count({ where: { account: { tenantId: t.id } } }),
                prisma.user.count({ where: { tenantId: t.id } }),
            ]);

            await prisma.tenantUsageSnapshot.upsert({
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
    } catch (err) {
        console.error("[Usage Snapshot]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/jobs/npa-check
router.post("/npa-check", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        const npaThreshold = new Date();
        npaThreshold.setDate(npaThreshold.getDate() - 90);

        const npaLoans = await prisma.loan.findMany({
            where: {
                tenantId: tenantId ?? undefined,
                status: "active",
                emiSchedule: { some: { status: "overdue", dueDate: { lt: npaThreshold } } },
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });

        res.json({ success: true, npaLoans, count: npaLoans.length });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
