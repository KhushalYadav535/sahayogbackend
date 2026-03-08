"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const gl_posting_1 = require("../../lib/gl-posting");
const risk_controls_1 = require("./risk-controls");
// AI-004: Fraud Scoring Helper
async function computeFraudScore(tenantId, tx) {
    let score = 0;
    // Pattern 1: Velocity check - same amount within 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentSameAmount = await prisma_1.default.transaction.count({
        where: {
            accountId: tx.accountId,
            amount: tx.amount,
            createdAt: { gte: fiveMinutesAgo },
        },
    });
    if (recentSameAmount > 1)
        score += 40; // Duplicate transaction
    // Pattern 2: Unusual amount (round numbers > 1L)
    if (tx.amount >= 100000 && tx.amount % 10000 === 0)
        score += 15;
    // Pattern 3: Large withdrawal relative to balance
    const account = await prisma_1.default.sbAccount.findUnique({ where: { id: tx.accountId } });
    if (account && tx.type === "debit") {
        const balanceRatio = tx.amount / Number(account.balance);
        if (balanceRatio > 0.9)
            score += 25; // Withdrawing >90% of balance
    }
    // Pattern 4: After-hours transaction (outside 9 AM - 6 PM)
    const hour = new Date().getHours();
    if (hour < 9 || hour > 18)
        score += 10;
    return Math.min(100, score);
}
const router = (0, express_1.Router)();
// POST /api/v1/sb/accounts — Open SB account
router.post("/accounts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.id;
        const { memberId, openingDeposit, interestRate, operationMode, nominee } = zod_1.z.object({
            memberId: zod_1.z.string(),
            openingDeposit: zod_1.z.number().min(500, "Opening deposit must be at least ₹500"),
            interestRate: zod_1.z.number().optional().default(4.0),
            operationMode: zod_1.z.string().optional().default("SINGLE"),
            nominee: zod_1.z.string().optional(),
        }).parse(req.body);
        // Verify member belongs to this tenant
        const member = await prisma_1.default.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // DA-001: Generate SB account number - SB-YYYY-NNNNNN format
        const count = await prisma_1.default.sbAccount.count({ where: { tenantId } });
        const { generateSbAccountId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
        const accountNumber = generateSbAccountId(count + 1);
        const account = await prisma_1.default.$transaction(async (tx) => {
            const created = await tx.sbAccount.create({
                data: {
                    tenantId,
                    memberId,
                    accountNumber,
                    accountType: "savings",
                    interestRate,
                    balance: openingDeposit,
                    ...(operationMode && { operationMode }),
                    ...(nominee && { nominee }),
                },
            });
            // Record opening deposit as a transaction
            await tx.transaction.create({
                data: {
                    accountId: created.id,
                    type: "credit",
                    category: "opening_deposit",
                    amount: openingDeposit,
                    balanceAfter: openingDeposit,
                    remarks: "Account opening deposit",
                },
            });
            return created;
        });
        await (0, audit_1.createAuditLog)({ userId, tenantId, action: "SB_ACCOUNT_OPEN", resource: "sbAccount", resourceId: account.id, newData: { accountNumber, memberId, openingDeposit } });
        res.status(201).json({ success: true, account });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, message: err.errors[0]?.message || "Validation error", errors: err.errors });
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
        const accountId = req.params.id;
        // Support lookup by both database ID (UUID) and accountNumber (SB-YYYY-NNNNNN)
        const account = await prisma_1.default.sbAccount.findFirst({
            where: {
                tenantId,
                OR: [
                    { id: accountId },
                    { accountNumber: accountId },
                ],
            },
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
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        // RSK-001: Transaction Velocity Check
        const velocityCheck = await (0, risk_controls_1.checkTransactionVelocity)(tenantId, req.params.id, "deposit", amount);
        if (!velocityCheck.allowed) {
            res.status(400).json({
                success: false,
                message: velocityCheck.reason,
                velocityId: velocityCheck.velocityId,
            });
            return;
        }
        // RSK-002: Daily Limit Check (for cash deposits)
        const dailyLimitCheck = await (0, risk_controls_1.checkDailyLimit)(tenantId, userId, req.params.id, amount, "ACCOUNT_CASH");
        if (!dailyLimitCheck.allowed) {
            res.status(400).json({
                success: false,
                message: dailyLimitCheck.reason,
                remaining: dailyLimitCheck.remaining,
            });
            return;
        }
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
        // AI-004: AI Fraud Scoring (async, non-blocking)
        setImmediate(async () => {
            try {
                const fraudScore = await computeFraudScore(tenantId, {
                    transactionId: tx.id,
                    accountId: req.params.id,
                    type: "credit",
                    amount,
                    category: "deposit",
                });
                if (fraudScore > 70) {
                    // Flag for compliance review
                    await prisma_1.default.aiAuditLog.create({
                        data: {
                            tenantId,
                            userId: req.user?.userId,
                            feature: "fraud_scoring",
                            inputData: JSON.stringify({ transactionId: tx.id, accountId: req.params.id }),
                            outputData: JSON.stringify({ fraudScore, flagged: true }),
                            success: true,
                            modelVersion: "v1.0",
                        },
                    });
                }
            }
            catch (err) {
                console.error("[Fraud Scoring]", err);
            }
        });
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
        // COA: Block withdrawal if account is dormant
        if (account.status === "dormant") {
            res.status(400).json({
                success: false,
                message: "Withdrawal blocked — account is dormant. Please complete KYC refresh to reactivate first.",
                accountStatus: "dormant",
                kycRefreshRequired: account.kycRefreshRequired,
            });
            return;
        }
        if (account.status !== "active") {
            res.status(400).json({ success: false, message: `Withdrawal not allowed in status: ${account.status}` });
            return;
        }
        if (Number(account.balance) < amount) {
            res.status(400).json({ success: false, message: "Insufficient balance" });
            return;
        }
        const newBalance = Number(account.balance) - amount;
        const tenantId = req.user.tenantId;
        const userId = req.user.userId;
        // RSK-001: Transaction Velocity Check
        const velocityCheck = await (0, risk_controls_1.checkTransactionVelocity)(tenantId, req.params.id, "withdraw", amount);
        if (!velocityCheck.allowed) {
            res.status(400).json({
                success: false,
                message: velocityCheck.reason,
                velocityId: velocityCheck.velocityId,
            });
            return;
        }
        // RSK-002: Daily Limit Check (for cash withdrawals)
        const dailyLimitCheck = await (0, risk_controls_1.checkDailyLimit)(tenantId, userId, req.params.id, amount, "ACCOUNT_CASH");
        if (!dailyLimitCheck.allowed) {
            res.status(400).json({
                success: false,
                message: dailyLimitCheck.reason,
                remaining: dailyLimitCheck.remaining,
            });
            return;
        }
        const period = (0, gl_posting_1.currentPeriod)();
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
        // COA: GL posting for withdrawal
        await (0, gl_posting_1.postGl)(req.user.tenantId, "SB_WITHDRAWAL", amount, `SB withdrawal — ${account.accountNumber}`, period);
        // AI-004: AI Fraud Scoring (async, non-blocking)
        setImmediate(async () => {
            try {
                const fraudScore = await computeFraudScore(tenantId, {
                    transactionId: tx.id,
                    accountId: req.params.id,
                    type: "debit",
                    amount,
                    category: "withdrawal",
                });
                if (fraudScore > 70) {
                    await prisma_1.default.aiAuditLog.create({
                        data: {
                            tenantId,
                            userId: req.user?.userId,
                            feature: "fraud_scoring",
                            inputData: JSON.stringify({ transactionId: tx.id, accountId: req.params.id }),
                            outputData: JSON.stringify({ fraudScore, flagged: true }),
                            success: true,
                            modelVersion: "v1.0",
                        },
                    });
                }
            }
            catch (err) {
                console.error("[Fraud Scoring]", err);
            }
        });
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
// GET /api/v1/sb/accounts/:id/passbook — SB-006: Digital Passbook/Statement
router.get("/accounts/:id/passbook", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { page = "1", limit = "30", startDate, endDate, format, language } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const account = await prisma_1.default.sbAccount.findFirst({
            where: { id: req.params.id, tenantId },
            include: { member: true },
        });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        const where = { accountId: req.params.id };
        if (startDate || endDate) {
            where.processedAt = {};
            if (startDate)
                where.processedAt.gte = new Date(startDate);
            if (endDate)
                where.processedAt.lte = new Date(endDate);
        }
        const [transactions, total] = await Promise.all([
            prisma_1.default.transaction.findMany({
                where,
                orderBy: { processedAt: "asc" }, // Chronological order for passbook
                skip,
                take: parseInt(limit),
            }),
            prisma_1.default.transaction.count({ where }),
        ]);
        // SB-006: PDF/Excel export
        if (format === "pdf" || format === "excel") {
            const lang = language || "en";
            const labels = {
                en: {
                    passbook: "Passbook",
                    accountNumber: "Account Number",
                    memberName: "Member Name",
                    date: "Date",
                    narration: "Narration",
                    debit: "Debit",
                    credit: "Credit",
                    balance: "Balance",
                    openingBalance: "Opening Balance",
                    closingBalance: "Closing Balance",
                },
                hi: {
                    passbook: "पासबुक",
                    accountNumber: "खाता संख्या",
                    memberName: "सदस्य का नाम",
                    date: "तारीख",
                    narration: "विवरण",
                    debit: "निकासी",
                    credit: "जमा",
                    balance: "शेष",
                    openingBalance: "प्रारंभिक शेष",
                    closingBalance: "अंतिम शेष",
                },
                mr: {
                    passbook: "पासबुक",
                    accountNumber: "खाते क्रमांक",
                    memberName: "सदस्याचे नाव",
                    date: "तारीख",
                    narration: "विवरण",
                    debit: "काढणे",
                    credit: "जमा",
                    balance: "शिल्लक",
                    openingBalance: "प्रारंभिक शिल्लक",
                    closingBalance: "अंतिम शिल्लक",
                },
            };
            const t = labels[lang] || labels.en;
            const openingBalance = transactions.length > 0 ? Number(transactions[0].balanceAfter) - Number(transactions[0].amount) * (transactions[0].type === "credit" ? 1 : -1) : Number(account.balance);
            const closingBalance = transactions.length > 0 ? Number(transactions[transactions.length - 1].balanceAfter) : Number(account.balance);
            if (format === "pdf") {
                // Generate HTML for PDF (client-side PDF generation)
                const html = `
<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <title>${t.passbook} - ${account.accountNumber}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 20px; }
        .account-info { margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #000; padding: 8px; text-align: left; }
        th { background-color: #f0f0f0; }
        .text-right { text-align: right; }
        .summary { margin-top: 20px; padding-top: 10px; border-top: 2px solid #000; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Sahayog AI Cooperative Society</h1>
        <h2>${t.passbook}</h2>
    </div>
    <div class="account-info">
        <p><strong>${t.accountNumber}:</strong> ${account.accountNumber}</p>
        <p><strong>${t.memberName}:</strong> ${account.member.firstName} ${account.member.lastName}</p>
    </div>
    <table>
        <thead>
            <tr>
                <th>${t.date}</th>
                <th>${t.narration}</th>
                <th class="text-right">${t.debit}</th>
                <th class="text-right">${t.credit}</th>
                <th class="text-right">${t.balance}</th>
            </tr>
        </thead>
        <tbody>
            ${transactions.map(tx => `
                <tr>
                    <td>${new Date(tx.processedAt).toLocaleDateString()}</td>
                    <td>${tx.remarks || tx.category}</td>
                    <td class="text-right">${tx.type === "debit" ? `₹${Number(tx.amount).toLocaleString()}` : "-"}</td>
                    <td class="text-right">${tx.type === "credit" ? `₹${Number(tx.amount).toLocaleString()}` : "-"}</td>
                    <td class="text-right">₹${Number(tx.balanceAfter).toLocaleString()}</td>
                </tr>
            `).join("")}
        </tbody>
    </table>
    <div class="summary">
        <p><strong>${t.openingBalance}:</strong> ₹${openingBalance.toLocaleString()}</p>
        <p><strong>${t.closingBalance}:</strong> ₹${closingBalance.toLocaleString()}</p>
    </div>
</body>
</html>`;
                res.setHeader("Content-Type", "text/html");
                res.setHeader("Content-Disposition", `inline; filename="Passbook_${account.accountNumber}.html"`);
                res.send(html);
                return;
            }
            if (format === "excel") {
                // CSV format for Excel
                const csv = [
                    [t.passbook, account.accountNumber].join(","),
                    [t.memberName, `${account.member.firstName} ${account.member.lastName}`].join(","),
                    [],
                    [t.date, t.narration, t.debit, t.credit, t.balance].join(","),
                    ...transactions.map(tx => [
                        new Date(tx.processedAt).toLocaleDateString(),
                        `"${(tx.remarks || tx.category).replace(/"/g, '""')}"`,
                        tx.type === "debit" ? Number(tx.amount) : "",
                        tx.type === "credit" ? Number(tx.amount) : "",
                        Number(tx.balanceAfter),
                    ].join(",")),
                    [],
                    [t.openingBalance, openingBalance].join(","),
                    [t.closingBalance, closingBalance].join(","),
                ].join("\n");
                res.setHeader("Content-Type", "text/csv");
                res.setHeader("Content-Disposition", `attachment; filename="Passbook_${account.accountNumber}.csv"`);
                res.send(csv);
                return;
            }
        }
        res.json({ success: true, transactions, total, account: { accountNumber: account.accountNumber, member: account.member } });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/sb/accounts/:id/reactivate — Reactivate dormant account after KYC refresh
router.post("/accounts/:id/reactivate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const account = await prisma_1.default.sbAccount.findFirst({ where: { id: req.params.id, tenantId } });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        if (account.status !== "dormant") {
            res.status(400).json({ success: false, message: "Account is not dormant" });
            return;
        }
        await prisma_1.default.sbAccount.update({
            where: { id: account.id },
            data: {
                status: "active",
                kycRefreshRequired: false,
                lastActivityAt: new Date(),
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "SB_ACCOUNT_REACTIVATED",
            entity: "SbAccount",
            entityId: account.id,
        });
        res.json({
            success: true,
            message: "Account reactivated. KYC refresh recorded.",
            accountNumber: account.accountNumber,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── SB-008: Bulk Dividend Credit ──────────────────────────────────────────────
router.post("/dividend/bulk-credit", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { dividendRate, resolutionRef, fiscalYear } = zod_1.z.object({
            dividendRate: zod_1.z.number().min(0).max(100), // Percentage
            resolutionRef: zod_1.z.string().min(1, "Resolution reference is required"),
            fiscalYear: zod_1.z.string(),
        }).parse(req.body);
        // Get all active members with REGULAR or NOMINAL category
        const members = await prisma_1.default.member.findMany({
            where: {
                tenantId,
                status: "active",
            },
            include: {
                sbAccounts: { where: { status: "active" }, take: 1 },
                shareLedger: true,
            },
        });
        // Calculate total shares per member
        const memberShares = members.map(m => {
            const totalShares = m.shareLedger.reduce((sum, tx) => {
                return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
            }, 0);
            return { member: m, shares: totalShares, sbAccount: m.sbAccounts[0] };
        }).filter(m => m.shares > 0 && m.sbAccount); // Only members with shares and SB account
        const results = [];
        const errors = [];
        for (const { member, shares, sbAccount } of memberShares) {
            try {
                const dividendAmount = Math.round((shares * 100 * dividendRate / 100) * 100) / 100; // Face value ₹100 per share
                if (!sbAccount) {
                    errors.push({ memberId: member.memberNumber, error: "No active SB account" });
                    continue;
                }
                const newBalance = Number(sbAccount.balance) + dividendAmount;
                await prisma_1.default.$transaction([
                    prisma_1.default.sbAccount.update({
                        where: { id: sbAccount.id },
                        data: { balance: newBalance, lastActivityAt: new Date() },
                    }),
                    prisma_1.default.transaction.create({
                        data: {
                            accountId: sbAccount.id,
                            type: "credit",
                            category: "dividend",
                            amount: dividendAmount,
                            balanceAfter: newBalance,
                            remarks: `Dividend credit — ${resolutionRef} (FY ${fiscalYear})`,
                            reference: resolutionRef,
                        },
                    }),
                ]);
                // GL posting: DR Dividend Payable, CR SB Account
                await (0, gl_posting_1.postGl)(tenantId, "DIVIDEND_PAID", dividendAmount, `Dividend credit — ${member.memberNumber} | Res: ${resolutionRef}`, (0, gl_posting_1.currentPeriod)());
                results.push({
                    memberId: member.memberNumber,
                    shares,
                    dividendAmount,
                    status: "credited",
                });
            }
            catch (err) {
                errors.push({ memberId: member.memberNumber, error: err.message });
            }
        }
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "BULK_DIVIDEND_CREDIT",
            entity: "SbAccount",
            newData: { dividendRate, resolutionRef, fiscalYear, totalCredited: results.length, totalFailed: errors.length },
            ipAddress: req.ip,
        });
        res.json({
            success: true,
            message: `Dividend credited to ${results.length} accounts`,
            dividendRate,
            resolutionRef,
            fiscalYear,
            totalCredited: results.length,
            totalFailed: errors.length,
            results,
            errors,
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── SB-011: AI Interest Anomaly Detection ─────────────────────────────────────
router.post("/interest/anomaly-check", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { accountId, expectedInterest, actualInterest, period } = zod_1.z.object({
            accountId: zod_1.z.string(),
            expectedInterest: zod_1.z.number(),
            actualInterest: zod_1.z.number(),
            period: zod_1.z.string(),
        }).parse(req.body);
        const account = await prisma_1.default.sbAccount.findFirst({ where: { id: accountId, tenantId } });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        const deviation = Math.abs(actualInterest - expectedInterest);
        const deviationPercent = (deviation / expectedInterest) * 100;
        const threshold = 0.5; // Default 0.5% threshold
        if (deviationPercent > threshold) {
            // Create anomaly record
            await prisma_1.default.aiAuditLog.create({
                data: {
                    tenantId,
                    feature: "sb_interest_anomaly",
                    inputData: JSON.stringify({ accountId, accountNumber: account.accountNumber, period }),
                    outputData: JSON.stringify({
                        expectedInterest,
                        actualInterest,
                        deviation,
                        deviationPercent: Math.round(deviationPercent * 100) / 100,
                        threshold,
                    }),
                    success: false,
                    errorMsg: `Interest anomaly detected: ${deviationPercent.toFixed(2)}% deviation`,
                },
            });
            // TODO: Send alert to accountant
            res.json({
                success: true,
                anomaly: true,
                message: "Interest anomaly detected",
                deviationPercent: Math.round(deviationPercent * 100) / 100,
                expectedInterest,
                actualInterest,
            });
            return;
        }
        res.json({ success: true, anomaly: false, message: "No anomaly detected" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=sb.js.map