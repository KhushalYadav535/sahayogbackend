import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

const DEFAULT_MEMBER_CAP: Record<string, number> = { starter: 500, pro: 2000, enterprise: -1 };

async function getMemberCapForTenant(tenantId: string): Promise<number> {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
    if (!tenant) return 500;
    const plan = (tenant.plan || "starter").toLowerCase().replace("professional", "pro");
    const cfg = await prisma.platformConfig.findUnique({ where: { key: "platform.member_cap.by_tier" } });
    if (!cfg?.value) return DEFAULT_MEMBER_CAP[plan] ?? 500;
    try {
        const parsed = JSON.parse(cfg.value) as Record<string, number>;
        const cap = parsed[plan] ?? DEFAULT_MEMBER_CAP[plan] ?? 500;
        return cap === -1 ? Infinity : cap;
    } catch {
        return DEFAULT_MEMBER_CAP[plan] ?? 500;
    }
}

const memberSchema = z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    dateOfBirth: z.string().optional(),
    gender: z.enum(["male", "female", "other"]).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    address: z.string().optional(),
    village: z.string().optional(),
    district: z.string().optional(),
    state: z.string().optional(),
    pincode: z.string().optional(),
    aadhaarNumber: z.string().optional(),
    panNumber: z.string().optional(),
    occupation: z.string().optional(),
    isMinor: z.boolean().optional(),
    guardianName: z.string().optional(),
    majorityDate: z.string().optional(),
    // MEM-012: Joint Membership
    jointMemberId: z.string().optional(),
    jointMode: z.enum(["EITHER_OR_SURVIVOR", "JOINTLY"]).optional(),
});

// GET /api/v1/members
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { page = "1", limit = "20", status, search } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status.toLowerCase();
        if (search) {
            where.OR = [
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { memberNumber: { contains: search, mode: "insensitive" } },
                { phone: { contains: search } },
            ];
        }

        const [members, total] = await Promise.all([
            prisma.member.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                include: { _count: { select: { sbAccounts: true, loans: true } } },
            }),
            prisma.member.count({ where }),
        ]);

        res.json({ success: true, members, total, page: parseInt(page), limit: parseInt(limit) });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/members/:id
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const member = await prisma.member.findFirst({
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members
router.post("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = memberSchema.parse(req.body);

        // Member cap enforcement (BRD 16.2)
        const memberCap = await getMemberCapForTenant(tenantId);
        const activeCount = await prisma.member.count({ where: { tenantId, status: "active" } });
        if (activeCount >= memberCap) {
            res.status(403).json({
                success: false,
                message: `Member limit reached (${memberCap === Infinity ? "unlimited" : memberCap}). Please upgrade your plan.`,
            });
            return;
        }

        // Generate member number - DA-001: MEM-YYYY-NNNNNN format
        const count = await prisma.member.count({ where: { tenantId } });
        const { generateMemberId } = await import("../../lib/id-generator");
        const memberNumber = generateMemberId(count + 1);

        const member = await prisma.member.create({
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

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "CREATE_MEMBER",
            entity: "Member",
            entityId: member.id,
            newData: data,
            ipAddress: req.ip,
        });

        res.status(201).json({ success: true, member });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PATCH /api/v1/members/:id
router.patch("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = memberSchema.partial().parse(req.body);
        const member = await prisma.member.update({
            where: { id: req.params.id },
            data: {
                ...data,
                dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
                majorityDate: data.majorityDate ? new Date(data.majorityDate) : undefined,
            },
        });
        await createAuditLog({ tenantId, userId: req.user?.userId, action: "UPDATE_MEMBER", entity: "Member", entityId: member.id, newData: data });
        res.json({ success: true, member });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:id/kyc/reinitiate — Reset KYC for re-verification
router.post("/:id/kyc/reinitiate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.id;
        const member = await prisma.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        await prisma.member.update({
            where: { id: memberId },
            data: { kycStatus: "pending", kycVerifiedAt: null },
        });
        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "KYC_REINITIATE",
            entity: "Member",
            entityId: member.id,
            newData: { message: "eKYC re-initiation requested" },
            ipAddress: req.ip,
        });
        res.json({ success: true, message: "KYC re-initiation requested. Member must complete verification." });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:id/kyc/verify
router.post("/:id/kyc/verify", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status, remarks } = z.object({ status: z.enum(["verified", "rejected"]), remarks: z.string().optional() }).parse(req.body);
        const member = await prisma.member.update({
            where: { id: req.params.id },
            data: {
                kycStatus: status,
                kycVerifiedAt: status === "verified" ? new Date() : undefined,
            },
        });
        await createAuditLog({ tenantId, userId: req.user?.userId, action: `KYC_${status.toUpperCase()}`, entity: "Member", entityId: member.id, newData: { status, remarks } });
        res.json({ success: true, member });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/members/:id/shares
router.get("/:id/shares", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const ledger = await prisma.shareLedger.findMany({
            where: { memberId: req.params.id },
            orderBy: { date: "desc" },
        });
        const totalShares = ledger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
        }, 0);
        res.json({ success: true, ledger, totalShares });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:id/shares
router.post("/:id/shares", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { transactionType, shares, faceValue, remarks } = z.object({
            transactionType: z.enum(["purchase", "refund"]),
            shares: z.number().int().positive(),
            faceValue: z.number().positive(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const entry = await prisma.shareLedger.create({
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET/POST /api/v1/members/:id/nominees
router.get("/:id/nominees", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    const nominees = await prisma.nominee.findMany({ where: { memberId: req.params.id } });
    res.json({ success: true, nominees });
});

router.post("/:id/nominees", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const data = z.object({
            name: z.string(),
            relationship: z.string(),
            dateOfBirth: z.string().optional(),
            sharePercent: z.number().int().min(1).max(100).default(100),
            phone: z.string().optional(),
            address: z.string().optional(),
        }).parse(req.body);

        const nominee = await prisma.nominee.create({
            data: { ...data, memberId: req.params.id, dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined },
        });
        res.status(201).json({ success: true, nominee });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// MEM-020: Form 15G/15H — GET status
router.get("/:id/form15", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const member = await prisma.member.findFirst({
            where: { id: req.params.id, tenantId: req.user!.tenantId! },
            select: { form15Status: true, form15Fy: true },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        res.json({ success: true, form15: { status: member.form15Status, fy: member.form15Fy } });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// MEM-020: Form 15G/15H — Submit (set EXEMPT for FY)
router.post("/:id/form15", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { formType, fy } = z
            .object({
                formType: z.enum(["15G", "15H"]),
                fy: z.string().regex(/^\d{4}-\d{2}$/, "Format: YYYY-MM for FY start"),
            })
            .parse(req.body);

        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        await prisma.member.update({
            where: { id: req.params.id },
            data: { form15Status: "EXEMPT", form15Fy: fy },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "FORM15_SUBMIT",
            entity: "Member",
            entityId: member.id,
            newData: { formType, fy },
        });

        res.json({ success: true, message: `Form ${formType} submitted for FY ${fy}` });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// MEM-020: Reset Form 15 at FY start (admin/job)
router.post("/:id/form15/reset", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        await prisma.member.update({
            where: { id: req.params.id },
            data: { form15Status: "NOT_EXEMPT", form15Fy: null },
        });
        res.json({ success: true, message: "Form 15 exemption reset" });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:id/exit
router.post("/:id/exit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { exitReason } = z.object({ exitReason: z.string() }).parse(req.body);
        const member = await prisma.member.update({
            where: { id: req.params.id },
            data: { status: "exited", exitDate: new Date(), exitReason },
        });
        res.json({ success: true, member });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:id/minor-to-major
router.post("/:id/minor-to-major", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const member = await prisma.member.update({
            where: { id: req.params.id },
            data: { isMinor: false, guardianName: null },
        });
        res.json({ success: true, member });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/members/:id/death-settlement — MEM-011: Get settlement data
router.get("/:id/death-settlement", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.id;
        const member = await prisma.member.findFirst({ where: { id: memberId, tenantId }, include: { nominees: true } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        const [sbAccounts, deposits, shareLedger, loans] = await Promise.all([
            prisma.sbAccount.findMany({ where: { memberId, tenantId } }),
            prisma.deposit.findMany({ where: { memberId, tenantId, status: "active" } }),
            prisma.shareLedger.findMany({ where: { memberId } }),
            prisma.loan.findMany({ where: { memberId, tenantId, status: "active" } }),
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:id/death-settlement — MEM-011: Complete death settlement
router.post("/:id/death-settlement", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.id;
        const { dateOfDeath, nomineeId } = z.object({
            dateOfDeath: z.string(),
            nomineeId: z.string().optional(),
        }).parse(req.body);

        const member = await prisma.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        await prisma.$transaction(async (tx) => {
            await tx.sbAccount.updateMany({ where: { memberId, tenantId }, data: { status: "closed", closedAt: new Date() } });
            await tx.deposit.updateMany({ where: { memberId, tenantId }, data: { status: "prematurely_closed", closedAt: new Date() } });
            await tx.member.update({
                where: { id: memberId },
                data: { status: "deceased", exitDate: new Date(dateOfDeath), exitReason: "Death" },
            });
        });

        const updated = await prisma.member.findFirst({ where: { id: memberId, tenantId } });
        res.json({ success: true, member: updated, message: "Death settlement completed" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/members/:id/ledger — Member Ledger (MEM-007) ─────
router.get("/:id/ledger", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.id;
        const { startDate, endDate, accountType, transactionType, minAmount, maxAmount } = req.query as Record<string, string>;

        // Verify member exists
        const member = await prisma.member.findFirst({ where: { id: memberId, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        const where: Record<string, unknown> = { memberId };
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) (where.createdAt as any).gte = new Date(startDate);
            if (endDate) (where.createdAt as any).lte = new Date(endDate);
        }

        // Collect transactions from all sources
        const [sbTransactions, shareTransactions, loanTransactions, depositTransactions] = await Promise.all([
            // SB Account transactions
            prisma.transaction.findMany({
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
            prisma.shareLedger.findMany({
                where: { memberId, tenantId },
                orderBy: { date: "desc" },
            }),
            // Loan transactions (EMI payments, etc.)
            prisma.loan.findMany({
                where: { memberId, tenantId },
                include: {
                    emiSchedule: {
                        where: { status: { in: ["paid", "partial"] } },
                        orderBy: { paidAt: "desc" },
                    },
                },
            }),
            // Deposit transactions (maturity, withdrawal)
            prisma.deposit.findMany({
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
        const ledgerEntries: any[] = [];

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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/suspend — MEM-017: Suspend Member ─────
router.post("/:id/suspend", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { reasonCode, remarks } = z.object({
            reasonCode: z.string(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        const previousStatus = member.status;
        await prisma.member.update({
            where: { id: req.params.id },
            data: { status: "suspended" },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "MEMBER_SUSPEND",
            entity: "Member",
            entityId: member.id,
            oldData: { status: previousStatus },
            newData: { status: "suspended", reasonCode, remarks },
            ipAddress: req.ip,
        });

        res.json({ success: true, message: "Member suspended", member: await prisma.member.findUnique({ where: { id: req.params.id } }) });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/blacklist — MEM-017: Blacklist Member ─────
router.post("/:id/blacklist", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { reasonCode, remarks } = z.object({
            reasonCode: z.string(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        const previousStatus = member.status;
        await prisma.member.update({
            where: { id: req.params.id },
            data: { status: "blacklisted" },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "MEMBER_BLACKLIST",
            entity: "Member",
            entityId: member.id,
            oldData: { status: previousStatus },
            newData: { status: "blacklisted", reasonCode, remarks },
            ipAddress: req.ip,
        });

        res.json({ success: true, message: "Member blacklisted", member: await prisma.member.findUnique({ where: { id: req.params.id } }) });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/reactivate — Reactivate Suspended Member ─────
router.post("/:id/reactivate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        if (member.status !== "suspended") {
            res.status(400).json({ success: false, message: "Member is not suspended" });
            return;
        }

        const previousStatus = member.status;
        await prisma.member.update({
            where: { id: req.params.id },
            data: { status: "active" },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "MEMBER_REACTIVATE",
            entity: "Member",
            entityId: member.id,
            oldData: { status: previousStatus },
            newData: { status: "active" },
            ipAddress: req.ip,
        });

        res.json({ success: true, message: "Member reactivated", member: await prisma.member.findUnique({ where: { id: req.params.id } }) });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/shares/transfer — MEM-016: Share Transfer ─────
router.post("/:id/shares/transfer", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { targetMemberId, shares, faceValue, resolutionRef, remarks } = z.object({
            targetMemberId: z.string(),
            shares: z.number().int().positive(),
            faceValue: z.number().positive(),
            resolutionRef: z.string(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const sourceMember = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        const targetMember = await prisma.member.findFirst({ where: { id: targetMemberId, tenantId } });

        if (!sourceMember || !targetMember) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        // Check source member has enough shares
        const sourceLedger = await prisma.shareLedger.findMany({ where: { memberId: sourceMember.id } });
        const sourceShares = sourceLedger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
        }, 0);

        if (sourceShares < shares) {
            res.status(400).json({ success: false, message: "Insufficient shares" });
            return;
        }

        // Create transfer entries (requires BOD approval - status pending)
        const transferAmount = shares * faceValue;
        await prisma.$transaction([
            // Debit source member
            prisma.shareLedger.create({
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
            prisma.shareLedger.create({
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

        await createAuditLog({
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
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/kyc/revalidate — MEM-014: KYC Re-validation ─────
router.post("/:id/kyc/revalidate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        // Reset KYC status for re-validation
        await prisma.member.update({
            where: { id: req.params.id },
            data: {
                kycStatus: "pending",
                kycVerifiedAt: null,
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "KYC_REVALIDATION_INITIATED",
            entity: "Member",
            entityId: member.id,
            newData: { message: "KYC re-validation initiated" },
            ipAddress: req.ip,
        });

        res.json({ success: true, message: "KYC re-validation initiated. Member must complete verification." });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/members/:id/certificate — MEM-019: Membership Certificate ─────
router.get("/:id/certificate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const member = await prisma.member.findFirst({
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
    } catch (err) {
        console.error("Certificate generation error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/bulk-import — MEM-018: Bulk Member Import ─────
router.post("/bulk-import", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { members } = z.object({
            members: z.array(z.object({
                firstName: z.string(),
                lastName: z.string(),
                dateOfBirth: z.string().optional(),
                gender: z.enum(["male", "female", "other"]).optional(),
                phone: z.string().optional(),
                email: z.string().email().optional(),
                address: z.string().optional(),
                aadhaarNumber: z.string().optional(),
                panNumber: z.string().optional(),
                occupation: z.string().optional(),
            })),
        }).parse(req.body);

        const results: any[] = [];
        const errors: any[] = [];

        for (let i = 0; i < members.length; i++) {
            const memberData = members[i];
            try {
                // Check for duplicates
                const existing = await prisma.member.findFirst({
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
                const count = await prisma.member.count({ where: { tenantId } });
                const { generateMemberId } = await import("../../lib/id-generator");
                const memberNumber = generateMemberId(count + 1);

                const member = await prisma.member.create({
                    data: {
                        tenantId,
                        memberNumber,
                        ...memberData,
                        dateOfBirth: memberData.dateOfBirth ? new Date(memberData.dateOfBirth) : undefined,
                    },
                });

                results.push({ row: i + 1, memberNumber: member.memberNumber, status: "created" });
            } catch (err: any) {
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
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/joint-link — MEM-012: Link Joint Member ─────
router.post("/:id/joint-link", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { jointMemberId, jointMode } = z.object({
            jointMemberId: z.string(),
            jointMode: z.enum(["EITHER_OR_SURVIVOR", "JOINTLY"]),
        }).parse(req.body);

        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });
        const jointMember = await prisma.member.findFirst({ where: { id: jointMemberId, tenantId } });

        if (!member || !jointMember) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        // Link both members
        await prisma.$transaction([
            prisma.member.update({
                where: { id: member.id },
                data: { jointMemberId: jointMember.id, jointMode },
            }),
            prisma.member.update({
                where: { id: jointMember.id },
                data: { jointMemberId: member.id, jointMode },
            }),
        ]);

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "JOINT_MEMBER_LINKED",
            entity: "Member",
            entityId: member.id,
            newData: { jointMemberId: jointMember.memberNumber, jointMode },
            ipAddress: req.ip,
        });

        res.json({ success: true, message: "Joint membership linked" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/members/:id/joint-unlink — MEM-012: Unlink Joint Member ─────
router.post("/:id/joint-unlink", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId } });

        if (!member || !member.jointMemberId) {
            res.status(404).json({ success: false, message: "Member not found or not linked" });
            return;
        }

        const jointMemberId = member.jointMemberId;

        // Unlink both members
        await prisma.$transaction([
            prisma.member.update({
                where: { id: member.id },
                data: { jointMemberId: null, jointMode: null },
            }),
            prisma.member.update({
                where: { id: jointMemberId },
                data: { jointMemberId: null, jointMode: null },
            }),
        ]);

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "JOINT_MEMBER_UNLINKED",
            entity: "Member",
            entityId: member.id,
            oldData: { jointMemberId },
            ipAddress: req.ip,
        });

        res.json({ success: true, message: "Joint membership unlinked" });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/members/bulk-import/template — Download Import Template ─────
router.get("/bulk-import/template", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    const csvTemplate = `firstName,lastName,dateOfBirth,gender,phone,email,address,village,district,state,pincode,aadhaarNumber,panNumber,occupation
John,Doe,1990-01-15,male,9876543210,john@example.com,123 Main St,Village,District,Maharashtra,400001,123456789012,ABCDE1234F,Farmer
Jane,Smith,1985-05-20,female,9876543211,jane@example.com,456 Oak Ave,Town,District,Maharashtra,400002,987654321098,FGHIJ5678K,Teacher`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=member_import_template.csv");
    res.send(csvTemplate);
});

export default router;
