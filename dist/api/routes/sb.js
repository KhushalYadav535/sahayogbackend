"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// POST /api/v1/sb/accounts — Open SB account
router.post("/accounts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { memberId, accountType, interestRate } = zod_1.z.object({
            memberId: zod_1.z.string(),
            accountType: zod_1.z.enum(["savings", "current", "fd", "rd"]).default("savings"),
            interestRate: zod_1.z.number().optional().default(3.5),
        }).parse(req.body);
        const count = await prisma_1.default.sbAccount.count({ where: { tenantId } });
        const accountNumber = `SB${String(count + 1).padStart(8, "0")}`;
        const account = await prisma_1.default.sbAccount.create({
            data: { tenantId, memberId, accountNumber, accountType, interestRate, balance: 0 },
        });
        res.status(201).json({ success: true, account });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/sb/accounts
router.get("/accounts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { memberId, status, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (memberId)
            where.memberId = memberId;
        if (status)
            where.status = status;
        const [accounts, total] = await Promise.all([
            prisma_1.default.sbAccount.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { openedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma_1.default.sbAccount.count({ where }),
        ]);
        res.json({ success: true, accounts, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/sb/accounts/:id
router.get("/accounts/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const account = await prisma_1.default.sbAccount.findFirst({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/sb/accounts/:id/deposit
router.post("/accounts/:id/deposit", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { amount, remarks } = zod_1.z.object({ amount: zod_1.z.number().positive(), remarks: zod_1.z.string().optional() }).parse(req.body);
        const account = await prisma_1.default.sbAccount.findUnique({ where: { id: req.params.id } });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        const newBalance = Number(account.balance) + amount;
        const [updatedAccount, tx] = await prisma_1.default.$transaction([
            prisma_1.default.sbAccount.update({ where: { id: req.params.id }, data: { balance: newBalance, lastActivityAt: new Date() } }),
            prisma_1.default.transaction.create({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/sb/accounts/:id/withdraw
router.post("/accounts/:id/withdraw", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { amount, remarks } = zod_1.z.object({ amount: zod_1.z.number().positive(), remarks: zod_1.z.string().optional() }).parse(req.body);
        const account = await prisma_1.default.sbAccount.findUnique({ where: { id: req.params.id } });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        if (Number(account.balance) < amount) {
            res.status(400).json({ success: false, message: "Insufficient balance" });
            return;
        }
        const newBalance = Number(account.balance) - amount;
        const [updatedAccount, tx] = await prisma_1.default.$transaction([
            prisma_1.default.sbAccount.update({ where: { id: req.params.id }, data: { balance: newBalance, lastActivityAt: new Date() } }),
            prisma_1.default.transaction.create({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/sb/transfers
router.post("/transfers", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { fromAccountId, toAccountId, amount, remarks } = zod_1.z.object({
            fromAccountId: zod_1.z.string(),
            toAccountId: zod_1.z.string(),
            amount: zod_1.z.number().positive(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const [from, to] = await Promise.all([
            prisma_1.default.sbAccount.findUnique({ where: { id: fromAccountId } }),
            prisma_1.default.sbAccount.findUnique({ where: { id: toAccountId } }),
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
        await prisma_1.default.$transaction([
            prisma_1.default.sbAccount.update({ where: { id: fromAccountId }, data: { balance: fromBal, lastActivityAt: new Date() } }),
            prisma_1.default.sbAccount.update({ where: { id: toAccountId }, data: { balance: toBal, lastActivityAt: new Date() } }),
            prisma_1.default.transaction.create({ data: { accountId: fromAccountId, type: "debit", category: "transfer", amount, balanceAfter: fromBal, remarks } }),
            prisma_1.default.transaction.create({ data: { accountId: toAccountId, type: "credit", category: "transfer", amount, balanceAfter: toBal, remarks } }),
        ]);
        res.json({ success: true, message: "Transfer successful" });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/sb/accounts/:id/passbook
router.get("/accounts/:id/passbook", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { page = "1", limit = "30" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [transactions, total] = await Promise.all([
            prisma_1.default.transaction.findMany({
                where: { accountId: req.params.id },
                orderBy: { processedAt: "desc" },
                skip,
                take: parseInt(limit),
            }),
            prisma_1.default.transaction.count({ where: { accountId: req.params.id } }),
        ]);
        res.json({ success: true, transactions, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=sb.js.map