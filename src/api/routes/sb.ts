import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// POST /api/v1/sb/accounts — Open SB account
router.post("/accounts", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { memberId, accountType, interestRate } = z.object({
            memberId: z.string(),
            accountType: z.enum(["savings", "current", "fd", "rd"]).default("savings"),
            interestRate: z.number().optional().default(3.5),
        }).parse(req.body);

        const count = await prisma.sbAccount.count({ where: { tenantId } });
        const accountNumber = `SB${String(count + 1).padStart(8, "0")}`;

        const account = await prisma.sbAccount.create({
            data: { tenantId, memberId, accountNumber, accountType, interestRate, balance: 0 },
        });

        res.status(201).json({ success: true, account });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/sb/accounts
router.get("/accounts", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { memberId, status, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (memberId) where.memberId = memberId;
        if (status) where.status = status;

        const [accounts, total] = await Promise.all([
            prisma.sbAccount.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { openedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma.sbAccount.count({ where }),
        ]);
        res.json({ success: true, accounts, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/sb/accounts/:id
router.get("/accounts/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const account = await prisma.sbAccount.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } },
                transactions: { orderBy: { processedAt: "desc" }, take: 50 },
            },
        });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        res.json({ success: true, account });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/sb/accounts/:id/deposit
router.post("/accounts/:id/deposit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { amount, remarks } = z.object({ amount: z.number().positive(), remarks: z.string().optional() }).parse(req.body);
        const account = await prisma.sbAccount.findUnique({ where: { id: req.params.id } });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }

        const newBalance = Number(account.balance) + amount;

        const [updatedAccount, tx] = await prisma.$transaction([
            prisma.sbAccount.update({ where: { id: req.params.id }, data: { balance: newBalance, lastActivityAt: new Date() } }),
            prisma.transaction.create({
                data: {
                    accountId: req.params.id,
                    type: "credit",
                    category: "deposit",
                    amount,
                    balanceAfter: newBalance,
                    remarks,
                },
            }),
        ]);

        res.json({ success: true, account: updatedAccount, transaction: tx });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/sb/accounts/:id/withdraw
router.post("/accounts/:id/withdraw", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { amount, remarks } = z.object({ amount: z.number().positive(), remarks: z.string().optional() }).parse(req.body);
        const account = await prisma.sbAccount.findUnique({ where: { id: req.params.id } });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        if (Number(account.balance) < amount) {
            res.status(400).json({ success: false, message: "Insufficient balance" });
            return;
        }

        const newBalance = Number(account.balance) - amount;

        const [updatedAccount, tx] = await prisma.$transaction([
            prisma.sbAccount.update({ where: { id: req.params.id }, data: { balance: newBalance, lastActivityAt: new Date() } }),
            prisma.transaction.create({
                data: {
                    accountId: req.params.id,
                    type: "debit",
                    category: "withdrawal",
                    amount,
                    balanceAfter: newBalance,
                    remarks,
                },
            }),
        ]);

        res.json({ success: true, account: updatedAccount, transaction: tx });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/sb/transfers
router.post("/transfers", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { fromAccountId, toAccountId, amount, remarks } = z.object({
            fromAccountId: z.string(),
            toAccountId: z.string(),
            amount: z.number().positive(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const [from, to] = await Promise.all([
            prisma.sbAccount.findUnique({ where: { id: fromAccountId } }),
            prisma.sbAccount.findUnique({ where: { id: toAccountId } }),
        ]);

        if (!from || !to) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        if (Number(from.balance) < amount) {
            res.status(400).json({ success: false, message: "Insufficient balance" });
            return;
        }

        const fromBal = Number(from.balance) - amount;
        const toBal = Number(to.balance) + amount;

        await prisma.$transaction([
            prisma.sbAccount.update({ where: { id: fromAccountId }, data: { balance: fromBal, lastActivityAt: new Date() } }),
            prisma.sbAccount.update({ where: { id: toAccountId }, data: { balance: toBal, lastActivityAt: new Date() } }),
            prisma.transaction.create({ data: { accountId: fromAccountId, type: "debit", category: "transfer", amount, balanceAfter: fromBal, remarks } }),
            prisma.transaction.create({ data: { accountId: toAccountId, type: "credit", category: "transfer", amount, balanceAfter: toBal, remarks } }),
        ]);

        res.json({ success: true, message: "Transfer successful" });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/sb/accounts/:id/passbook
router.get("/accounts/:id/passbook", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { page = "1", limit = "30" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [transactions, total] = await Promise.all([
            prisma.transaction.findMany({
                where: { accountId: req.params.id },
                orderBy: { processedAt: "desc" },
                skip,
                take: parseInt(limit),
            }),
            prisma.transaction.count({ where: { accountId: req.params.id } }),
        ]);
        res.json({ success: true, transactions, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
