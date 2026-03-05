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

        // Generate member number
        const count = await prisma.member.count({ where: { tenantId } });
        const memberNumber = `M${String(count + 1).padStart(6, "0")}`;

        const member = await prisma.member.create({
            data: {
                tenantId,
                memberNumber,
                ...data,
                dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
                majorityDate: data.majorityDate ? new Date(data.majorityDate) : undefined,
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

export default router;
