import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// POST /api/v1/deposits — Create FDR/RD/MIS
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

        // Validate member exists and is active
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

        const count = await prisma.deposit.count({ where: { tenantId } });
        const prefix = data.depositType.toUpperCase().slice(0, 2);
        const depositNumber = `${prefix}${String(count + 1).padStart(8, "0")}`;

        const openedAt = new Date();
        const maturityDate = new Date(openedAt);
        maturityDate.setMonth(maturityDate.getMonth() + data.tenureMonths);

        const n = data.compoundingFreq === "monthly" ? 12 : data.compoundingFreq === "quarterly" ? 4 : data.compoundingFreq === "half_yearly" ? 2 : 1;
        const principal = Number(data.principal);
        const rate = data.interestRate / 100;
        const months = data.tenureMonths;
        const maturityAmount = principal * Math.pow(1 + rate / n, (n * months) / 12);

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
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });

        res.status(201).json({ success: true, deposit });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/deposits
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

// GET /api/v1/deposits/:id
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const deposit = await prisma.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } },
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

export default router;
