import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// GET /api/v1/loans/eligibility/:memberId — LN-002 pre-check
router.get("/eligibility/:memberId", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { evaluateEligibility } = await import("../../services/eligibility.service");
        const { result, ruleVersion } = await evaluateEligibility(tenantId, req.params.memberId);
        res.json({ success: true, eligibility: result, ruleVersion });
    } catch (e) {
        res.status(500).json({ success: false, message: (e as Error).message });
    }
});

// POST /api/v1/loans/applications
router.post("/applications", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            memberId: z.string(),
            loanType: z.enum(["personal", "agricultural", "business", "housing", "education", "gold"]),
            amountRequested: z.number().positive(),
            purpose: z.string().optional(),
            tenureMonths: z.number().int().positive(),
        }).parse(req.body);

        // LN-002: Run eligibility rule engine first
        const { evaluateEligibility } = await import("../../services/eligibility.service");
        const { result: eligibility, ruleVersion } = await evaluateEligibility(tenantId, data.memberId);
        if (!eligibility.eligible) {
            res.status(400).json({
                success: false,
                message: "Loan eligibility check failed",
                eligibility: { ...eligibility, ruleVersion },
            });
            return;
        }

        // Simple risk scoring (rule-based; Bytez integration stub)
        const riskScore = Math.random() * 100;
        const riskCategory = riskScore > 70 ? "LOW" : riskScore > 40 ? "MEDIUM" : "HIGH";

        const application = await prisma.loanApplication.create({
            data: {
                tenantId,
                ...data,
                amountRequested: data.amountRequested,
                riskScore,
                riskCategory,
                status: "pending",
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "CREATE_LOAN_APPLICATION",
            entity: "LoanApplication",
            entityId: application.id,
        });

        res.status(201).json({ success: true, application, eligibility: { ...eligibility, ruleVersion } });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/loans/applications
router.get("/applications", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;

        const [applications, total] = await Promise.all([
            prisma.loanApplication.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { appliedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma.loanApplication.count({ where }),
        ]);
        res.json({ success: true, applications, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/loans/applications/:id/approve
router.post("/applications/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { remarks } = z.object({ remarks: z.string().optional() }).parse(req.body);

        const app = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: { status: "approved", reviewedAt: new Date(), reviewedBy: req.user?.userId, remarks },
        });
        res.json({ success: true, application: app });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/loans/applications/:id/reject
router.post("/applications/:id/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { remarks } = z.object({ remarks: z.string() }).parse(req.body);
        const app = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: { status: "rejected", reviewedAt: new Date(), reviewedBy: req.user?.userId, remarks },
        });
        res.json({ success: true, application: app });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/loans/applications/:id/disburse
router.post("/applications/:id/disburse", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { disbursedAmount, interestRate } = z.object({
            disbursedAmount: z.number().positive(),
            interestRate: z.number().positive(),
        }).parse(req.body);

        const application = await prisma.loanApplication.findUnique({ where: { id: req.params.id } });
        if (!application || application.status !== "approved") {
            res.status(400).json({ success: false, message: "Application not in approved state" });
            return;
        }

        const count = await prisma.loan.count({ where: { tenantId } });
        const loanNumber = `L${String(count + 1).padStart(7, "0")}`;

        // Generate EMI schedule (flat rate)
        const monthlyInterest = (disbursedAmount * (interestRate / 100)) / 12;
        const emi = disbursedAmount / application.tenureMonths + monthlyInterest;
        const emiScheduleData = Array.from({ length: application.tenureMonths }, (_, i) => ({
            installmentNo: i + 1,
            dueDate: new Date(Date.now() + (i + 1) * 30 * 24 * 60 * 60 * 1000),
            principal: disbursedAmount / application.tenureMonths,
            interest: monthlyInterest,
            totalEmi: emi,
        }));

        const loan = await prisma.$transaction(async (tx) => {
            const newLoan = await tx.loan.create({
                data: {
                    tenantId,
                    memberId: application.memberId,
                    applicationId: application.id,
                    loanNumber,
                    loanType: application.loanType,
                    principalAmount: application.amountRequested,
                    interestRate,
                    tenureMonths: application.tenureMonths,
                    disbursedAmount,
                    disbursedAt: new Date(),
                    outstandingPrincipal: disbursedAmount,
                    status: "active",
                },
            });

            await tx.emiSchedule.createMany({
                data: emiScheduleData.map((e) => ({ ...e, loanId: newLoan.id })),
            });

            await tx.loanApplication.update({ where: { id: req.params.id }, data: { status: "disbursed" } });

            return newLoan;
        });

        // ACC-002: Auto GL posting for disbursement
        await postGlFromMatrix(
            tenantId,
            "LOAN_DISBURSEMENT",
            disbursedAmount,
            `Loan disbursement ${loanNumber} - ${application.loanType}`,
            period
        );

        res.status(201).json({ success: true, loan });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/loans
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status, memberId, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;
        if (memberId) where.memberId = memberId;

        const [loans, total] = await Promise.all([
            prisma.loan.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma.loan.count({ where }),
        ]);
        res.json({ success: true, loans, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/loans/:id
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const loan = await prisma.loan.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: true,
                emiSchedule: { orderBy: { installmentNo: "asc" } },
                application: true,
            },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        res.json({ success: true, loan });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/loans/:id/emi/pay
router.post("/:id/emi/pay", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { emiId, amount, remarks } = z.object({
            emiId: z.string(),
            amount: z.number().positive(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const emi = await prisma.emiSchedule.findUnique({ where: { id: emiId } });
        if (!emi) {
            res.status(404).json({ success: false, message: "EMI not found" });
            return;
        }

        const paidAmount = Number(emi.paidAmount) + amount;
        const status = paidAmount >= Number(emi.totalEmi) ? "paid" : "partial";

        const updated = await prisma.emiSchedule.update({
            where: { id: emiId },
            data: { paidAmount, paidAt: status === "paid" ? new Date() : undefined, status },
        });

        res.json({ success: true, emi: updated });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/loans/:id/write-off
router.post("/:id/write-off", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { writeOffAmount, remarks } = z.object({ writeOffAmount: z.number().positive(), remarks: z.string().optional() }).parse(req.body);
        const loan = await prisma.loan.update({
            where: { id: req.params.id },
            data: { status: "written-off", writeOffDate: new Date(), writeOffAmount },
        });
        res.json({ success: true, loan });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
