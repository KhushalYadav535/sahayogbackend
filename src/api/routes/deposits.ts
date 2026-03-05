import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { postGl, currentPeriod } from "../../lib/gl-posting";
import {
    computeTds,
    SENIOR_CITIZEN_AGE,
    DORMANCY_MONTHS,
    DEAF_TRIGGER_YEARS,
} from "../../lib/coa-rules";

const router = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

function isSeniorCitizen(dateOfBirth: Date | null | undefined): boolean {
    if (!dateOfBirth) return false;
    const today = new Date();
    const age = today.getFullYear() - dateOfBirth.getFullYear() -
        (today < new Date(today.getFullYear(), dateOfBirth.getMonth(), dateOfBirth.getDate()) ? 1 : 0);
    return age >= SENIOR_CITIZEN_AGE;
}

// ─── POST /api/v1/deposits — Create FDR/RD/MIS ─────────────────────────────
router.post("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const schema = z.object({
            memberId: z.string(),
            depositType: z.enum(["fd", "rd", "mis"]),
            principal: z.number().positive(),
            interestRate: z.number().min(0).max(20),
            tenureMonths: z.number().int().positive(),
            compoundingFreq: z.enum(["monthly", "quarterly", "half_yearly", "yearly"]).default("quarterly"),
            rdMonthlyAmount: z.number().positive().optional(),
            form15Exempt: z.boolean().optional(),
        });
        const data = schema.parse(req.body);

        // Validate member
        const member = await prisma.member.findFirst({
            where: { id: data.memberId, tenantId },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        if (member.status !== "active") {
            res.status(400).json({ success: false, message: "Member must be active to open deposit" });
            return;
        }

        // COA: Detect senior citizen from DOB
        const senior = isSeniorCitizen(member.dateOfBirth);

        // COA: Compute projected annual interest for TDS estimation
        const annual = Number(data.principal) * (data.interestRate / 100);
        const tdsInfo = computeTds(annual, senior, !!member.panNumber, data.form15Exempt ?? false);

        const count = await prisma.deposit.count({ where: { tenantId } });
        const prefix = data.depositType.toUpperCase().slice(0, 2);
        const depositNumber = `${prefix}${String(count + 1).padStart(8, "0")}`;

        const openedAt = new Date();
        const maturityDate = new Date(openedAt);
        maturityDate.setMonth(maturityDate.getMonth() + data.tenureMonths);

        const n = data.compoundingFreq === "monthly" ? 12 :
            data.compoundingFreq === "quarterly" ? 4 :
                data.compoundingFreq === "half_yearly" ? 2 : 1;
        const principal = Number(data.principal);
        const rate = data.interestRate / 100;
        const months = data.tenureMonths;
        const maturityAmount = principal * Math.pow(1 + rate / n, (n * months) / 12);

        // Determine GL code for deposit type
        const depositGlCode = data.depositType === "fd" ? "FDR_OPEN" :
            data.depositType === "rd" ? "RD_OPEN" : "MIS_OPEN";

        const deposit = await prisma.deposit.create({
            data: {
                tenantId,
                memberId: data.memberId,
                depositNumber,
                depositType: data.depositType,
                principal: data.principal,
                interestRate: data.interestRate,
                tenureMonths: data.tenureMonths,
                compoundingFreq: data.compoundingFreq,
                maturityDate,
                maturityAmount: Math.round(maturityAmount * 100) / 100,
                rdMonthlyAmount: data.rdMonthlyAmount ?? null,
                status: "active",
                // COA fields
                isSeniorCitizen: senior,
                form15Exempt: data.form15Exempt ?? false,
                tdsApplicable: tdsInfo.tdsApplicable,
                accruedInterest: 0,
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });

        // COA: GL Posting on deposit open
        await postGl(tenantId, depositGlCode as any, Number(data.principal),
            `${data.depositType.toUpperCase()} opened — ${depositNumber}`, currentPeriod());

        res.status(201).json({
            success: true,
            deposit,
            tdsInfo: {
                isSeniorCitizen: senior,
                tdsApplicable: tdsInfo.tdsApplicable,
                tdsThreshold: tdsInfo.threshold,
                tdsRate: tdsInfo.rate,
                projectedAnnualInterest: Math.round(annual * 100) / 100,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            const issues = (err as any).errors ?? err.issues ?? [];
            const message = issues.map((e: any) => `${(e.path || []).join(".") || "body"}: ${e.message}`).join("; ");
            res.status(400).json({ success: false, message, errors: issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/deposits ───────────────────────────────────────────────────
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { memberId, status, depositType, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (memberId) where.memberId = memberId;
        if (status) where.status = status;
        if (depositType) where.depositType = depositType;

        const [deposits, total] = await Promise.all([
            prisma.deposit.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { openedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma.deposit.count({ where }),
        ]);
        res.json({ success: true, deposits, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/deposits/maturing — Get deposits maturing soon ──────────────
router.get("/maturing", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { days = "30" } = req.query as Record<string, string>;
        const daysNum = parseInt(days);
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() + daysNum);

        const maturingDeposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                maturityDate: { lte: cutoffDate },
            },
            include: { 
                member: { 
                    select: { 
                        firstName: true, 
                        lastName: true, 
                        memberNumber: true,
                        phone: true 
                    } 
                } 
            },
            orderBy: { maturityDate: "asc" },
        });

        res.json({ success: true, deposits: maturingDeposits });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/deposits/:id ───────────────────────────────────────────────
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const deposit = await prisma.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true, panNumber: true } },
            },
        });
        if (!deposit) {
            res.status(404).json({ success: false, message: "Deposit not found" });
            return;
        }
        res.json({ success: true, deposit });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/deposits/:id/mature — Settle at maturity ─────────────────
router.post("/:id/mature", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const deposit = await prisma.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: { member: true },
        });
        if (!deposit) {
            res.status(404).json({ success: false, message: "Deposit not found" });
            return;
        }
        if (deposit.status !== "active") {
            res.status(400).json({ success: false, message: "Deposit is not active" });
            return;
        }
        if (deposit.maturityDate && deposit.maturityDate > new Date()) {
            res.status(400).json({ success: false, message: "Deposit has not yet matured" });
            return;
        }

        const totalInterest = Number(deposit.accruedInterest);
        const { tdsAmount } = computeTds(
            totalInterest,
            deposit.isSeniorCitizen,
            !!deposit.member.panNumber,
            deposit.form15Exempt
        );

        const netPayable = Number(deposit.principal) + totalInterest - tdsAmount;

        await prisma.deposit.update({
            where: { id: deposit.id },
            data: {
                status: "matured",
                closedAt: new Date(),
                tdsDeducted: tdsAmount,
            },
        });

        // GL: TDS deducted
        if (tdsAmount > 0) {
            await postGl(tenantId, "FDR_TDS_DEDUCTED", tdsAmount,
                `TDS deducted on maturity — ${deposit.depositNumber}`, currentPeriod());
        }

        // GL: Maturity payout
        await postGl(tenantId, "FDR_MATURE", netPayable,
            `FDR maturity payout — ${deposit.depositNumber}`, currentPeriod());

        res.json({
            success: true,
            message: "Deposit matured and settled",
            principal: deposit.principal,
            totalInterest,
            tdsDeducted: tdsAmount,
            netPayable: Math.round(netPayable * 100) / 100,
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/deposits/:id/lien — Mark or clear FDR lien ───────────────
router.post("/:id/lien", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { loanId, action } = z.object({
            loanId: z.string().optional(),
            action: z.enum(["mark", "clear"]),
        }).parse(req.body);

        const deposit = await prisma.deposit.findFirst({ where: { id: req.params.id, tenantId } });
        if (!deposit) {
            res.status(404).json({ success: false, message: "Deposit not found" });
            return;
        }

        if (action === "mark") {
            if (deposit.lienLoanId) {
                res.status(400).json({ success: false, message: "Deposit already has an active lien" });
                return;
            }
            await prisma.deposit.update({
                where: { id: deposit.id },
                data: { lienLoanId: loanId ?? null, status: "lien_marked" },
            });
            return res.json({ success: true, message: "Lien marked on deposit" }) as any;
        } else {
            await prisma.deposit.update({
                where: { id: deposit.id },
                data: { lienLoanId: null, status: "active" },
            });
            return res.json({ success: true, message: "Lien cleared from deposit" }) as any;
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/deposits/:id/withdraw — Premature withdrawal ─────────────
router.post("/:id/withdraw", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const deposit = await prisma.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: { member: true },
        });
        if (!deposit) {
            res.status(404).json({ success: false, message: "Deposit not found" });
            return;
        }

        // COA DEP-010: Block withdrawal if lien is active
        if (deposit.lienLoanId) {
            res.status(400).json({
                success: false,
                message: "DEP-010: Premature withdrawal blocked — lien is active on this deposit (linked to a loan). Please close the loan first.",
                lienLoanId: deposit.lienLoanId,
            });
            return;
        }
        if (deposit.status === "dormant") {
            res.status(400).json({ success: false, message: "Deposit is dormant. Please reactivate before withdrawal." });
            return;
        }
        if (deposit.status !== "active") {
            res.status(400).json({ success: false, message: "Deposit cannot be withdrawn in current state" });
            return;
        }

        // Premature: typically reduced interest (assume 1% penalty on rate simplistically)
        const totalInterest = Number(deposit.accruedInterest);
        const { tdsAmount } = computeTds(
            totalInterest,
            deposit.isSeniorCitizen,
            !!deposit.member.panNumber,
            deposit.form15Exempt
        );
        const netPayable = Number(deposit.principal) + totalInterest - tdsAmount;

        await prisma.deposit.update({
            where: { id: deposit.id },
            data: { status: "prematurely_closed", closedAt: new Date(), tdsDeducted: tdsAmount },
        });

        // GL postings
        if (tdsAmount > 0) {
            await postGl(tenantId, "FDR_TDS_DEDUCTED", tdsAmount,
                `TDS on premature withdrawal — ${deposit.depositNumber}`, currentPeriod());
        }
        await postGl(tenantId, "FDR_MATURE", netPayable,
            `Premature withdrawal — ${deposit.depositNumber}`, currentPeriod());

        res.json({
            success: true,
            message: "Deposit closed (premature withdrawal)",
            principal: deposit.principal,
            totalInterest,
            tdsDeducted: tdsAmount,
            netPayable: Math.round(netPayable * 100) / 100,
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/deposits/alerts/deaf — Deposits near DEAF trigger ──────────
router.get("/alerts/deaf", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const alertThreshold = new Date();
        alertThreshold.setFullYear(alertThreshold.getFullYear() - Math.floor(DEAF_TRIGGER_YEARS * 0.95)); // 9.5 years

        const unclaimedDeposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                maturityDate: { lt: alertThreshold },
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } } },
        });

        res.json({ success: true, unclaimedDeposits, count: unclaimedDeposits.length });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/deposits/:id/interest-accrual — Accrue daily interest ─────
router.post("/:id/interest-accrual", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const deposit = await prisma.deposit.findFirst({ where: { id: req.params.id, tenantId } });
        if (!deposit || deposit.status !== "active") {
            res.status(404).json({ success: false, message: "Active deposit not found" });
            return;
        }

        const dailyRate = Number(deposit.interestRate) / 100 / 365;
        const dailyInterest = Math.round(Number(deposit.principal) * dailyRate * 100) / 100;

        await prisma.deposit.update({
            where: { id: deposit.id },
            data: { accruedInterest: Number(deposit.accruedInterest) + dailyInterest },
        });

        // GL: FDR interest accrual
        await postGl(tenantId, "FDR_INTEREST_ACCRUAL", dailyInterest,
            `Daily interest accrual — ${deposit.depositNumber}`, currentPeriod());

        res.json({ success: true, dailyInterest, totalAccrued: Number(deposit.accruedInterest) + dailyInterest });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
