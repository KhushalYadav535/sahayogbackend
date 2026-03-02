/**
 * Module 10 — Compliance & Regulatory Reports
 * NABARD, TDS 26Q, STR, AML
 */
import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/v1/compliance/nabard-report
router.get("/nabard-report", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { period } = req.query as Record<string, string>;
        const p = period || new Date().toISOString().slice(0, 7);

        const [members, deposits, loans, glSummary] = await Promise.all([
            prisma.member.count({ where: { tenantId, status: "active" } }),
            prisma.deposit.aggregate({
                where: { tenantId, status: "active" },
                _sum: { principal: true },
            }),
            prisma.loan.aggregate({
                where: { tenantId, status: "active" },
                _sum: { outstandingPrincipal: true },
            }),
            prisma.glEntry.groupBy({
                by: ["glName"],
                where: { tenantId, period: p },
                _sum: { debit: true, credit: true },
            }),
        ]);

        const totalDeposits = Number(deposits._sum.principal ?? 0);
        const totalLoans = Number(loans._sum.outstandingPrincipal ?? 0);
        const assets = glSummary.filter((g) => g.glName.includes("Loans") || g.glName.includes("Cash")).reduce((s, g) => s + Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0), 0);
        const liabilities = glSummary.filter((g) => g.glName.includes("Deposits") || g.glName.includes("Share")).reduce((s, g) => s + Number(g._sum.credit ?? 0) - Number(g._sum.debit ?? 0), 0);

        res.json({
            success: true,
            report: {
                period: p,
                memberCount: members,
                totalDeposits,
                totalLoans,
                totalAssets: assets,
                totalLiabilities: liabilities,
                format: "NABARD",
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/tds-26q
router.get("/tds-26q", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { quarter } = req.query as Record<string, string>; // 2024-Q1 format
        const [y, q] = quarter ? quarter.split("-Q").map(Number) : [new Date().getFullYear(), Math.ceil((new Date().getMonth() + 1) / 3)];
        const startMonth = (q - 1) * 3 + 1;
        const startDate = new Date(y, startMonth - 1, 1);
        const endDate = new Date(y, startMonth + 2, 0);

        const deposits = await prisma.deposit.findMany({
            where: { tenantId, status: "active" },
            include: { member: { select: { panNumber: true, firstName: true, lastName: true, form15Status: true, form15Fy: true } } },
        });

        const fy = `${y}-${String(startMonth).padStart(2, "0")}`;
        const rows: { pan: string; name: string; interest: number; tds: number; form15Exempt: boolean }[] = [];

        for (const d of deposits) {
            const principal = Number(d.principal);
            const rate = Number(d.interestRate);
            const monthsInQuarter = 3;
            const interest = (principal * rate * monthsInQuarter) / (100 * 12);
            const exempt = d.member.form15Status === "EXEMPT" && d.member.form15Fy === fy;
            const tds = exempt ? 0 : interest > 40000 / 4 ? interest * 0.1 : 0; // 10% TDS if quarterly interest > 10k
            rows.push({
                pan: d.member.panNumber || "N/A",
                name: `${d.member.firstName} ${d.member.lastName}`,
                interest: Math.round(interest * 100) / 100,
                tds: Math.round(tds * 100) / 100,
                form15Exempt: exempt,
            });
        }

        res.json({
            success: true,
            report: {
                quarter: `${y}-Q${q}`,
                period: { start: startDate.toISOString(), end: endDate.toISOString() },
                rows,
                totalTds: rows.reduce((s, r) => s + r.tds, 0),
                format: "26Q",
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/str
router.get("/str", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { from, to } = req.query as Record<string, string>;
        const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const toDate = to ? new Date(to) : new Date();

        const [largeDeposits, largeWithdrawals, suspiciousTx] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    account: { tenantId },
                    type: "credit",
                    processedAt: { gte: fromDate, lte: toDate },
                    amount: { gte: 100000 },
                },
                include: { account: { include: { member: { select: { memberNumber: true, firstName: true, lastName: true } } } } },
                take: 100,
            }),
            prisma.transaction.findMany({
                where: {
                    account: { tenantId },
                    type: "debit",
                    processedAt: { gte: fromDate, lte: toDate },
                    amount: { gte: 100000 },
                },
                include: { account: { include: { member: { select: { memberNumber: true, firstName: true, lastName: true } } } } },
                take: 100,
            }),
            prisma.transaction.count({
                where: { account: { tenantId }, processedAt: { gte: fromDate, lte: toDate }, amount: { gte: 500000 } },
            }),
        ]);

        res.json({
            success: true,
            report: {
                type: "STR",
                period: { from: fromDate.toISOString(), to: toDate.toISOString() },
                largeDeposits: largeDeposits.map((t) => ({
                    date: t.processedAt,
                    amount: Number(t.amount),
                    member: t.account.member,
                    category: t.category,
                })),
                largeWithdrawals: largeWithdrawals.map((t) => ({
                    date: t.processedAt,
                    amount: Number(t.amount),
                    member: t.account.member,
                    category: t.category,
                })),
                highValueTxCount: suspiciousTx,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/aml
router.get("/aml", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { from } = req.query as Record<string, string>;
        const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [flaggedTx, kycPending] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    account: { tenantId },
                    processedAt: { gte: fromDate },
                    amount: { gte: 100000 },
                },
                include: { account: { include: { member: true } } },
                orderBy: { processedAt: "desc" },
                take: 50,
            }),
            prisma.member.count({ where: { tenantId, kycStatus: "pending" } }),
        ]);

        res.json({
            success: true,
            report: {
                type: "AML",
                period: { from: fromDate.toISOString() },
                flaggedTransactions: flaggedTx.length,
                kycPendingMembers: kycPending,
                flaggedDetails: flaggedTx.map((t) => ({
                    id: t.id,
                    date: t.processedAt,
                    amount: Number(t.amount),
                    type: t.type,
                    member: t.account.member.memberNumber,
                    reason: Number(t.amount) >= 500000 ? "High value" : "Threshold",
                })),
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
