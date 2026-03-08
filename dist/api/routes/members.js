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
const router = (0, express_1.Router)();
const DEFAULT_MEMBER_CAP = { starter: 500, pro: 2000, enterprise: -1 };
async function getMemberCapForTenant(tenantId) {
    const tenant = await prisma_1.default.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
    if (!tenant)
        return 500;
    const plan = (tenant.plan || "starter").toLowerCase().replace("professional", "pro");
    const cfg = await prisma_1.default.platformConfig.findUnique({ where: { key: "platform.member_cap.by_tier" } });
    if (!cfg?.value)
        return DEFAULT_MEMBER_CAP[plan] ?? 500;
    try {
        const parsed = JSON.parse(cfg.value);
        const cap = parsed[plan] ?? DEFAULT_MEMBER_CAP[plan] ?? 500;
        return cap === -1 ? Infinity : cap;
    }
    catch {
        return DEFAULT_MEMBER_CAP[plan] ?? 500;
    }
}
const memberSchema = zod_1.z.object({
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    dateOfBirth: zod_1.z.string().optional(),
    gender: zod_1.z.enum(["male", "female", "other"]).optional(),
    phone: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    address: zod_1.z.string().optional(),
    village: zod_1.z.string().optional(),
    district: zod_1.z.string().optional(),
    state: zod_1.z.string().optional(),
    pincode: zod_1.z.string().optional(),
    aadhaarNumber: zod_1.z.string().optional(),
    panNumber: zod_1.z.string().optional(),
    occupation: zod_1.z.string().optional(),
    isMinor: zod_1.z.boolean().optional(),
    guardianName: zod_1.z.string().optional(),
    majorityDate: zod_1.z.string().optional(),
    // MEM-012: Joint Membership
    jointMemberId: zod_1.z.string().optional(),
    jointMode: zod_1.z.enum(["EITHER_OR_SURVIVOR", "JOINTLY"]).optional(),
});
// GET /api/v1/members
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { page = "1", limit = "20", status, search } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (status)
            where.status = status.toLowerCase();
        if (search) {
            where.OR = [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { memberNumber: { contains: search, mode: "insensitive" } },
                { phone: { contains: search } },
            ];
        }
        const [members, total] = await Promise.all([
            prisma_1.default.member.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                include: { _count: { select: { sbAccounts: true, loans: true } } },
            }),
            prisma_1.default.member.count({ where }),
        ]);
        res.json({ success: true, members, total, page: parseInt(page), limit: parseInt(limit) });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/members/:id
router.get("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                shareLedger: { orderBy: { date: "desc" }, take: 10 },
                nominees: true,
                sbAccounts: { select: { id: true, accountNumber: true, accountType: true, balance: true, status: true } },
                loans: { select: { id: true, loanNumber: true, loanType: true, disbursedAmount: true, status: true } },
            },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        res.json({ success: true, member });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members
router.post("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = memberSchema.parse(req.body);
        // Member cap enforcement (BRD 16.2)
        const memberCap = await getMemberCapForTenant(tenantId);
        const activeCount = await prisma_1.default.member.count({ where: { tenantId, status: "active" } });
        if (activeCount >= memberCap) {
            res.status(403).json({
                success: false,
                message: `Member limit reached (${memberCap === Infinity ? "unlimited" : memberCap}). Please upgrade your plan.`,
            });
            return;
        }
        // Generate member number - DA-001: MEM-YYYY-NNNNNN format
        const count = await prisma_1.default.member.count({ where: { tenantId } });
        const { generateMemberId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
        const memberNumber = generateMemberId(count + 1);
        const member = await prisma_1.default.member.create({
            data: {
                tenantId,
                memberNumber,
                ...data,
                dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
                majorityDate: data.majorityDate ? new Date(data.majorityDate) : undefined,
                jointMemberId: data.jointMemberId || undefined,
                jointMode: data.jointMode || undefined,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "CREATE_MEMBER",
            entity: "Member",
            entityId: member.id,
            newData: data,
            ipAddress: req.ip,
        });
        res.status(201).json({ success: true, member });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PATCH /api/v1/members/:id
router.patch("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = memberSchema.partial().parse(req.body);
        const member = await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: {
                ...data,
                dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
                majorityDate: data.majorityDate ? new Date(data.majorityDate) : undefined,
            },
        });
        await (0, audit_1.createAuditLog)({ tenantId, userId: req.user?.userId, action: "UPDATE_MEMBER", entity: "Member", entityId: member.id, newData: data });
        res.json({ success: true, member });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:id/kyc/reinitiate — Reset KYC for re-verification
router.post("/:id/kyc/reinitiate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.id;
        const member = await prisma_1.default.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        await prisma_1.default.member.update({
            where: { id: memberId },
            data: { kycStatus: "pending", kycVerifiedAt: null },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "KYC_REINITIATE",
            entity: "Member",
            entityId: member.id,
            newData: { message: "eKYC re-initiation requested" },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "KYC re-initiation requested. Member must complete verification." });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:id/kyc/verify
router.post("/:id/kyc/verify", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status, remarks } = zod_1.z.object({ status: zod_1.z.enum(["verified", "rejected"]), remarks: zod_1.z.string().optional() }).parse(req.body);
        const member = await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: {
                kycStatus: status,
                kycVerifiedAt: status === "verified" ? new Date() : undefined,
            },
        });
        await (0, audit_1.createAuditLog)({ tenantId, userId: req.user?.userId, action: `KYC_${status.toUpperCase()}`, entity: "Member", entityId: member.id, newData: { status, remarks } });
        res.json({ success: true, member });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/members/:id/shares
router.get("/:id/shares", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const ledger = await prisma_1.default.shareLedger.findMany({
            where: { memberId: req.params.id },
            orderBy: { date: "desc" },
        });
        const totalShares = ledger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
        }, 0);
        res.json({ success: true, ledger, totalShares });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:id/shares
router.post("/:id/shares", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { transactionType, shares, faceValue, remarks } = zod_1.z.object({
            transactionType: zod_1.z.enum(["purchase", "refund"]),
            shares: zod_1.z.number().int().positive(),
            faceValue: zod_1.z.number().positive(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const entry = await prisma_1.default.shareLedger.create({
            data: {
                memberId: req.params.id,
                tenantId,
                transactionType,
                shares,
                faceValue,
                amount: shares * faceValue,
                remarks,
            },
        });
        res.status(201).json({ success: true, entry });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET/POST /api/v1/members/:id/nominees
router.get("/:id/nominees", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    const nominees = await prisma_1.default.nominee.findMany({ where: { memberId: req.params.id } });
    res.json({ success: true, nominees });
});
router.post("/:id/nominees", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const data = zod_1.z.object({
            name: zod_1.z.string(),
            relationship: zod_1.z.string(),
            dateOfBirth: zod_1.z.string().optional(),
            sharePercent: zod_1.z.number().int().min(1).max(100).default(100),
            phone: zod_1.z.string().optional(),
            address: zod_1.z.string().optional(),
        }).parse(req.body);
        const nominee = await prisma_1.default.nominee.create({
            data: { ...data, memberId: req.params.id, dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined },
        });
        res.status(201).json({ success: true, nominee });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MEM-020: Form 15G/15H — GET status
router.get("/:id/form15", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const member = await prisma_1.default.member.findFirst({
            where: { id: req.params.id, tenantId: req.user.tenantId },
            select: { form15Status: true, form15Fy: true },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        res.json({ success: true, form15: { status: member.form15Status, fy: member.form15Fy } });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MEM-020: Form 15G/15H — Submit (set EXEMPT for FY)
router.post("/:id/form15", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { formType, fy } = zod_1.z
            .object({
            formType: zod_1.z.enum(["15G", "15H"]),
            fy: zod_1.z.string().regex(/^\d{4}-\d{2}$/, "Format: YYYY-MM for FY start"),
        })
            .parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { form15Status: "EXEMPT", form15Fy: fy },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "FORM15_SUBMIT",
            entity: "Member",
            entityId: member.id,
            newData: { formType, fy },
        });
        res.json({ success: true, message: `Form ${formType} submitted for FY ${fy}` });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MEM-020: Reset Form 15 at FY start (admin/job)
router.post("/:id/form15/reset", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { form15Status: "NOT_EXEMPT", form15Fy: null },
        });
        res.json({ success: true, message: "Form 15 exemption reset" });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:id/exit
router.post("/:id/exit", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { exitReason } = zod_1.z.object({ exitReason: zod_1.z.string() }).parse(req.body);
        const member = await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { status: "exited", exitDate: new Date(), exitReason },
        });
        res.json({ success: true, member });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:id/minor-to-major
router.post("/:id/minor-to-major", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const member = await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { isMinor: false, guardianName: null },
        });
        res.json({ success: true, member });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/members/:id/death-settlement — MEM-011: Get settlement data
router.get("/:id/death-settlement", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.id;
        const member = await prisma_1.default.member.findFirst({ where: { id: memberId, tenantId }, include: { nominees: true } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const [sbAccounts, deposits, shareLedger, loans] = await Promise.all([
            prisma_1.default.sbAccount.findMany({ where: { memberId, tenantId } }),
            prisma_1.default.deposit.findMany({ where: { memberId, tenantId, status: "active" } }),
            prisma_1.default.shareLedger.findMany({ where: { memberId } }),
            prisma_1.default.loan.findMany({ where: { memberId, tenantId, status: "active" } }),
        ]);
        const sbBalance = sbAccounts.reduce((s, a) => s + Number(a.balance), 0);
        const fdrMaturity = deposits.reduce((s, d) => s + Number(d.maturityAmount || d.principal), 0);
        const shareCapital = shareLedger.reduce((s, l) => {
            return l.transactionType === "purchase" ? s + Number(l.amount) : s - Number(l.amount);
        }, 0);
        const loanOutstanding = loans.reduce((s, l) => s + Number(l.outstandingPrincipal) + Number(l.outstandingInterest), 0);
        res.json({
            success: true,
            member: { id: member.id, memberNumber: member.memberNumber, firstName: member.firstName, lastName: member.lastName },
            nominees: member.nominees,
            accounts: sbAccounts.map(a => ({ id: a.id, accountNumber: a.accountNumber, accountType: a.accountType, balance: Number(a.balance) })),
            deposits: deposits.map(d => ({ id: d.id, depositNumber: d.depositNumber, depositType: d.depositType, principal: Number(d.principal), maturityAmount: Number(d.maturityAmount || d.principal) })),
            settlement: { sbBalance, fdrMaturity: Math.round(fdrMaturity * 100) / 100, shareCapital, loanOutstanding },
            netPayable: Math.round((sbBalance + fdrMaturity + Math.max(0, shareCapital) - loanOutstanding) * 100) / 100,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:id/death-settlement — MEM-011: Complete death settlement
router.post("/:id/death-settlement", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.id;
        const { dateOfDeath, nomineeId } = zod_1.z.object({
            dateOfDeath: zod_1.z.string(),
            nomineeId: zod_1.z.string().optional(),
        }).parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        await prisma_1.default.$transaction(async (tx) => {
            await tx.sbAccount.updateMany({ where: { memberId, tenantId }, data: { status: "closed", closedAt: new Date() } });
            await tx.deposit.updateMany({ where: { memberId, tenantId }, data: { status: "prematurely_closed", closedAt: new Date() } });
            await tx.member.update({
                where: { id: memberId },
                data: { status: "deceased", exitDate: new Date(dateOfDeath), exitReason: "Death" },
            });
        });
        const updated = await prisma_1.default.member.findFirst({ where: { id: memberId, tenantId } });
        res.json({ success: true, member: updated, message: "Death settlement completed" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/members/:id/ledger — Member Ledger (MEM-007) ─────
router.get("/:id/ledger", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.id;
        const { startDate, endDate, accountType, transactionType, minAmount, maxAmount } = req.query;
        // Verify member exists
        const member = await prisma_1.default.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const where = { memberId };
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate)
                where.createdAt.gte = new Date(startDate);
            if (endDate)
                where.createdAt.lte = new Date(endDate);
        }
        // Collect transactions from all sources
        const [sbTransactions, shareTransactions, loanTransactions, depositTransactions] = await Promise.all([
            // SB Account transactions
            prisma_1.default.transaction.findMany({
                where: {
                    account: { memberId, tenantId },
                    ...(accountType === "sb" ? {} : accountType ? { account: { accountType } } : {}),
                    ...(transactionType ? { category: transactionType } : {}),
                    ...(minAmount || maxAmount ? {
                        amount: {
                            ...(minAmount ? { gte: parseFloat(minAmount) } : {}),
                            ...(maxAmount ? { lte: parseFloat(maxAmount) } : {}),
                        },
                    } : {}),
                },
                include: { account: { select: { accountNumber: true, accountType: true } } },
                orderBy: { createdAt: "desc" },
            }),
            // Share ledger transactions
            prisma_1.default.shareLedger.findMany({
                where: { memberId, tenantId },
                orderBy: { date: "desc" },
            }),
            // Loan transactions (EMI payments, etc.)
            prisma_1.default.loan.findMany({
                where: { memberId, tenantId },
                include: {
                    emiSchedule: {
                        where: { status: { in: ["paid", "partial"] } },
                        orderBy: { paidAt: "desc" },
                    },
                },
            }),
            // Deposit transactions (maturity, withdrawal)
            prisma_1.default.deposit.findMany({
                where: {
                    memberId,
                    tenantId,
                    OR: [
                        { status: "matured" },
                        { status: "prematurely_closed" },
                    ],
                },
                orderBy: { closedAt: "desc" },
            }),
        ]);
        // Format ledger entries
        const ledgerEntries = [];
        // SB transactions
        sbTransactions.forEach(tx => {
            ledgerEntries.push({
                date: tx.createdAt,
                type: "account",
                accountType: tx.account.accountType,
                accountNumber: tx.account.accountNumber,
                transactionType: tx.category,
                description: tx.remarks || `${tx.type} - ${tx.category}`,
                debit: tx.type === "debit" ? Number(tx.amount) : 0,
                credit: tx.type === "credit" ? Number(tx.amount) : 0,
                balance: Number(tx.balanceAfter),
            });
        });
        // Share transactions
        shareTransactions.forEach(tx => {
            ledgerEntries.push({
                date: tx.date,
                type: "share",
                transactionType: tx.transactionType,
                description: `Share ${tx.transactionType} - ${tx.shares} shares @ ₹${tx.faceValue}`,
                debit: tx.transactionType === "refund" ? Number(tx.amount) : 0,
                credit: tx.transactionType === "purchase" ? Number(tx.amount) : 0,
                shares: tx.shares,
                amount: Number(tx.amount),
            });
        });
        // Loan transactions
        loanTransactions.forEach(loan => {
            loan.emiSchedule.forEach(emi => {
                if (emi.paidAt) {
                    ledgerEntries.push({
                        date: emi.paidAt,
                        type: "loan",
                        loanNumber: loan.loanNumber,
                        transactionType: "emi_payment",
                        description: `EMI Payment - Installment #${emi.installmentNo}`,
                        debit: Number(emi.paidAmount),
                        credit: 0,
                        principal: Number(emi.principal),
                        interest: Number(emi.interest),
                    });
                }
            });
        });
        // Deposit transactions
        depositTransactions.forEach(deposit => {
            ledgerEntries.push({
                date: deposit.closedAt,
                type: "deposit",
                depositNumber: deposit.depositNumber,
                depositType: deposit.depositType,
                transactionType: deposit.status === "matured" ? "maturity" : "premature_withdrawal",
                description: `${deposit.depositType.toUpperCase()} ${deposit.status === "matured" ? "Matured" : "Premature Withdrawal"}`,
                debit: 0,
                credit: Number(deposit.maturityAmount || deposit.principal),
                principal: Number(deposit.principal),
                interest: Number(deposit.accruedInterest),
            });
        });
        // Sort by date
        ledgerEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        res.json({
            success: true,
            member: { id: member.id, memberNumber: member.memberNumber, name: `${member.firstName} ${member.lastName}` },
            ledger: ledgerEntries,
            total: ledgerEntries.length,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/members/:id/suspend — MEM-017: Suspend Member ─────
router.post("/:id/suspend", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { reasonCode, remarks } = zod_1.z.object({
            reasonCode: zod_1.z.string(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const previousStatus = member.status;
        await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { status: "suspended" },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "MEMBER_SUSPEND",
            entity: "Member",
            entityId: member.id,
            oldData: { status: previousStatus },
            newData: { status: "suspended", reasonCode, remarks },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "Member suspended", member: await prisma_1.default.member.findUnique({ where: { id: req.params.id } }) });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/members/:id/blacklist — MEM-017: Blacklist Member ─────
router.post("/:id/blacklist", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { reasonCode, remarks } = zod_1.z.object({
            reasonCode: zod_1.z.string(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const previousStatus = member.status;
        await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { status: "blacklisted" },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "MEMBER_BLACKLIST",
            entity: "Member",
            entityId: member.id,
            oldData: { status: previousStatus },
            newData: { status: "blacklisted", reasonCode, remarks },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "Member blacklisted", member: await prisma_1.default.member.findUnique({ where: { id: req.params.id } }) });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/members/:id/reactivate — Reactivate Suspended Member ─────
router.post("/:id/reactivate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        if (member.status !== "suspended") {
            res.status(400).json({ success: false, message: "Member is not suspended" });
            return;
        }
        const previousStatus = member.status;
        await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: { status: "active" },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "MEMBER_REACTIVATE",
            entity: "Member",
            entityId: member.id,
            oldData: { status: previousStatus },
            newData: { status: "active" },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "Member reactivated", member: await prisma_1.default.member.findUnique({ where: { id: req.params.id } }) });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/members/:id/shares/transfer — MEM-016: Share Transfer ─────
router.post("/:id/shares/transfer", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { targetMemberId, shares, faceValue, resolutionRef, remarks } = zod_1.z.object({
            targetMemberId: zod_1.z.string(),
            shares: zod_1.z.number().int().positive(),
            faceValue: zod_1.z.number().positive(),
            resolutionRef: zod_1.z.string(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const sourceMember = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        const targetMember = await prisma_1.default.member.findFirst({ where: { id: targetMemberId, tenantId } });
        if (!sourceMember || !targetMember) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Check source member has enough shares
        const sourceLedger = await prisma_1.default.shareLedger.findMany({ where: { memberId: sourceMember.id } });
        const sourceShares = sourceLedger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
        }, 0);
        if (sourceShares < shares) {
            res.status(400).json({ success: false, message: "Insufficient shares" });
            return;
        }
        // Create transfer entries (requires BOD approval - status pending)
        const transferAmount = shares * faceValue;
        await prisma_1.default.$transaction([
            // Debit source member
            prisma_1.default.shareLedger.create({
                data: {
                    memberId: sourceMember.id,
                    tenantId,
                    transactionType: "transfer",
                    shares: -shares,
                    faceValue,
                    amount: -transferAmount,
                    remarks: `Transfer to ${targetMember.memberNumber} - ${resolutionRef}`,
                },
            }),
            // Credit target member
            prisma_1.default.shareLedger.create({
                data: {
                    memberId: targetMember.id,
                    tenantId,
                    transactionType: "transfer",
                    shares,
                    faceValue,
                    amount: transferAmount,
                    remarks: `Transfer from ${sourceMember.memberNumber} - ${resolutionRef}`,
                },
            }),
        ]);
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "SHARE_TRANSFER",
            entity: "ShareLedger",
            entityId: sourceMember.id,
            newData: { sourceMember: sourceMember.memberNumber, targetMember: targetMember.memberNumber, shares, resolutionRef },
            ipAddress: req.ip,
        });
        res.json({
            success: true,
            message: "Share transfer recorded (pending BOD approval)",
            transfer: {
                from: sourceMember.memberNumber,
                to: targetMember.memberNumber,
                shares,
                amount: transferAmount,
                resolutionRef,
            },
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
// ─── POST /api/v1/members/:id/kyc/revalidate — MEM-014: KYC Re-validation ─────
router.post("/:id/kyc/revalidate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Reset KYC status for re-validation
        await prisma_1.default.member.update({
            where: { id: req.params.id },
            data: {
                kycStatus: "pending",
                kycVerifiedAt: null,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "KYC_REVALIDATION_INITIATED",
            entity: "Member",
            entityId: member.id,
            newData: { message: "KYC re-validation initiated" },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "KYC re-validation initiated. Member must complete verification." });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/members/:id/certificate — MEM-019: Membership Certificate ─────
router.get("/:id/certificate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                tenant: { select: { name: true } },
                shareLedger: true,
            },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const totalShares = member.shareLedger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
        }, 0);
        const certificateHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Membership Certificate - ${member.memberNumber}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
        .header { text-align: center; border-bottom: 3px solid #000; padding-bottom: 20px; margin-bottom: 30px; }
        .society-name { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
        .certificate-title { font-size: 20px; font-weight: bold; margin-top: 15px; }
        .member-no { font-family: monospace; font-size: 14px; color: #0066cc; margin-top: 10px; }
        .details { margin: 30px 0; }
        .detail-row { display: flex; justify-content: space-between; margin: 12px 0; padding: 8px 0; border-bottom: 1px dotted #ccc; }
        .detail-label { font-weight: bold; width: 40%; }
        .detail-value { width: 60%; text-align: right; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #000; font-size: 12px; text-align: center; color: #666; }
        .signature-section { margin-top: 50px; display: flex; justify-content: space-between; }
        .signature-box { width: 45%; text-align: center; }
        .signature-line { border-top: 1px solid #000; margin-top: 60px; padding-top: 5px; }
        @media print { body { margin: 20px; } }
    </style>
</head>
<body>
    <div class="header">
        <div class="society-name">${member.tenant.name || "Sahayog AI Cooperative Society"}</div>
        <div style="font-size: 12px; color: #666;">Registered under Maharashtra Co-operative Societies Act</div>
        <div class="certificate-title">MEMBERSHIP CERTIFICATE</div>
        <div class="member-no">Certificate No: ${member.memberNumber}</div>
    </div>

    <div class="details">
        <div class="detail-row">
            <span class="detail-label">Member Name:</span>
            <span class="detail-value">${member.firstName} ${member.lastName}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Member Number:</span>
            <span class="detail-value">${member.memberNumber}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Date of Joining:</span>
            <span class="detail-value">${member.joinDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Shares Held:</span>
            <span class="detail-value">${totalShares} shares</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Status:</span>
            <span class="detail-value">${member.status.toUpperCase()}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">KYC Status:</span>
            <span class="detail-value">${member.kycStatus.toUpperCase()}</span>
        </div>
    </div>

    <div class="signature-section">
        <div class="signature-box">
            <div class="signature-line">Secretary</div>
        </div>
        <div class="signature-box">
            <div class="signature-line">President</div>
        </div>
    </div>

    <div class="footer">
        <p>This certificate is computer generated and does not require physical signature.</p>
        <p>Generated on: ${new Date().toLocaleString('en-IN')}</p>
    </div>
</body>
</html>`;
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Content-Disposition", `inline; filename="Membership_Certificate_${member.memberNumber}.html"`);
        res.send(certificateHtml);
    }
    catch (err) {
        console.error("Certificate generation error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/members/bulk-import — MEM-018: Bulk Member Import ─────
router.post("/bulk-import", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { members } = zod_1.z.object({
            members: zod_1.z.array(zod_1.z.object({
                firstName: zod_1.z.string(),
                lastName: zod_1.z.string(),
                dateOfBirth: zod_1.z.string().optional(),
                gender: zod_1.z.enum(["male", "female", "other"]).optional(),
                phone: zod_1.z.string().optional(),
                email: zod_1.z.string().email().optional(),
                address: zod_1.z.string().optional(),
                aadhaarNumber: zod_1.z.string().optional(),
                panNumber: zod_1.z.string().optional(),
                occupation: zod_1.z.string().optional(),
            })),
        }).parse(req.body);
        const results = [];
        const errors = [];
        for (let i = 0; i < members.length; i++) {
            const memberData = members[i];
            try {
                // Check for duplicates
                const existing = await prisma_1.default.member.findFirst({
                    where: {
                        tenantId,
                        OR: [
                            { aadhaarNumber: memberData.aadhaarNumber },
                            { phone: memberData.phone },
                        ],
                    },
                });
                if (existing) {
                    errors.push({ row: i + 1, member: `${memberData.firstName} ${memberData.lastName}`, error: "Duplicate member found" });
                    continue;
                }
                // DA-001: Generate member number - MEM-YYYY-NNNNNN format
                const count = await prisma_1.default.member.count({ where: { tenantId } });
                const { generateMemberId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
                const memberNumber = generateMemberId(count + 1);
                const member = await prisma_1.default.member.create({
                    data: {
                        tenantId,
                        memberNumber,
                        ...memberData,
                        dateOfBirth: memberData.dateOfBirth ? new Date(memberData.dateOfBirth) : undefined,
                    },
                });
                results.push({ row: i + 1, memberNumber: member.memberNumber, status: "created" });
            }
            catch (err) {
                errors.push({ row: i + 1, member: `${memberData.firstName} ${memberData.lastName}`, error: err.message });
            }
        }
        res.json({
            success: true,
            imported: results.length,
            failed: errors.length,
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
// ─── POST /api/v1/members/:id/joint-link — MEM-012: Link Joint Member ─────
router.post("/:id/joint-link", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { jointMemberId, jointMode } = zod_1.z.object({
            jointMemberId: zod_1.z.string(),
            jointMode: zod_1.z.enum(["EITHER_OR_SURVIVOR", "JOINTLY"]),
        }).parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        const jointMember = await prisma_1.default.member.findFirst({ where: { id: jointMemberId, tenantId } });
        if (!member || !jointMember) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Link both members
        await prisma_1.default.$transaction([
            prisma_1.default.member.update({
                where: { id: member.id },
                data: { jointMemberId: jointMember.id, jointMode },
            }),
            prisma_1.default.member.update({
                where: { id: jointMember.id },
                data: { jointMemberId: member.id, jointMode },
            }),
        ]);
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "JOINT_MEMBER_LINKED",
            entity: "Member",
            entityId: member.id,
            newData: { jointMemberId: jointMember.memberNumber, jointMode },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "Joint membership linked" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/members/:id/joint-unlink — MEM-012: Unlink Joint Member ─────
router.post("/:id/joint-unlink", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const member = await prisma_1.default.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member || !member.jointMemberId) {
            res.status(404).json({ success: false, message: "Member not found or not linked" });
            return;
        }
        const jointMemberId = member.jointMemberId;
        // Unlink both members
        await prisma_1.default.$transaction([
            prisma_1.default.member.update({
                where: { id: member.id },
                data: { jointMemberId: null, jointMode: null },
            }),
            prisma_1.default.member.update({
                where: { id: jointMemberId },
                data: { jointMemberId: null, jointMode: null },
            }),
        ]);
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "JOINT_MEMBER_UNLINKED",
            entity: "Member",
            entityId: member.id,
            oldData: { jointMemberId },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "Joint membership unlinked" });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/members/bulk-import/template — Download Import Template ─────
router.get("/bulk-import/template", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    const csvTemplate = `firstName,lastName,dateOfBirth,gender,phone,email,address,village,district,state,pincode,aadhaarNumber,panNumber,occupation
John,Doe,1990-01-15,male,9876543210,john@example.com,123 Main St,Village,District,Maharashtra,400001,123456789012,ABCDE1234F,Farmer
Jane,Smith,1985-05-20,female,9876543211,jane@example.com,456 Oak Ave,Town,District,Maharashtra,400002,987654321098,FGHIJ5678K,Teacher`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=member_import_template.csv");
    res.send(csvTemplate);
});
exports.default = router;
//# sourceMappingURL=members.js.map