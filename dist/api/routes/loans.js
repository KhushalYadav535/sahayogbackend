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
// GET /api/v1/loans/eligibility/:memberId — LN-002 pre-check
router.get("/eligibility/:memberId", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { evaluateEligibility } = await Promise.resolve().then(() => __importStar(require("../../services/eligibility.service")));
        const { result, ruleVersion } = await evaluateEligibility(tenantId, req.params.memberId);
        res.json({ success: true, eligibility: result, ruleVersion });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// POST /api/v1/loans/applications
router.post("/applications", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            memberId: zod_1.z.string(),
            loanType: zod_1.z.enum(["personal", "agricultural", "business", "housing", "education", "gold"]),
            amountRequested: zod_1.z.number().positive(),
            purpose: zod_1.z.string().optional(),
            tenureMonths: zod_1.z.number().int().positive(),
        }).parse(req.body);
        // LN-002: Run eligibility rule engine first
        const { evaluateEligibility } = await Promise.resolve().then(() => __importStar(require("../../services/eligibility.service")));
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
        const application = await prisma_1.default.loanApplication.create({
            data: {
                tenantId,
                ...data,
                amountRequested: data.amountRequested,
                riskScore,
                riskCategory,
                status: "pending",
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "CREATE_LOAN_APPLICATION",
            entity: "LoanApplication",
            entityId: application.id,
        });
        res.status(201).json({ success: true, application, eligibility: { ...eligibility, ruleVersion } });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/loans/applications
router.get("/applications", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (status)
            where.status = status;
        const [applications, total] = await Promise.all([
            prisma_1.default.loanApplication.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { appliedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma_1.default.loanApplication.count({ where }),
        ]);
        res.json({ success: true, applications, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/loans/applications/:id/approve
router.post("/applications/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { remarks } = zod_1.z.object({ remarks: zod_1.z.string().optional() }).parse(req.body);
        const app = await prisma_1.default.loanApplication.update({
            where: { id: req.params.id },
            data: { status: "approved", reviewedAt: new Date(), reviewedBy: req.user?.userId, remarks },
        });
        res.json({ success: true, application: app });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/loans/applications/:id/reject
router.post("/applications/:id/reject", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { remarks } = zod_1.z.object({ remarks: zod_1.z.string() }).parse(req.body);
        const app = await prisma_1.default.loanApplication.update({
            where: { id: req.params.id },
            data: { status: "rejected", reviewedAt: new Date(), reviewedBy: req.user?.userId, remarks },
        });
        res.json({ success: true, application: app });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/loans/applications/:id/disburse
router.post("/applications/:id/disburse", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { disbursedAmount, interestRate } = zod_1.z.object({
            disbursedAmount: zod_1.z.number().positive(),
            interestRate: zod_1.z.number().positive(),
        }).parse(req.body);
        const application = await prisma_1.default.loanApplication.findUnique({ where: { id: req.params.id } });
        if (!application || application.status !== "approved") {
            res.status(400).json({ success: false, message: "Application not in approved state" });
            return;
        }
        const count = await prisma_1.default.loan.count({ where: { tenantId } });
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
        const loan = await prisma_1.default.$transaction(async (tx) => {
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
        await postGlFromMatrix(tenantId, "LOAN_DISBURSEMENT", disbursedAmount, `Loan disbursement ${loanNumber} - ${application.loanType}`, period);
        res.status(201).json({ success: true, loan });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/loans
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status, memberId, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (status)
            where.status = status;
        if (memberId)
            where.memberId = memberId;
        const [loans, total] = await Promise.all([
            prisma_1.default.loan.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma_1.default.loan.count({ where }),
        ]);
        res.json({ success: true, loans, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/loans/:id
router.get("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const loan = await prisma_1.default.loan.findFirst({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/loans/:id/emi/pay
router.post("/:id/emi/pay", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { emiId, amount, remarks } = zod_1.z.object({
            emiId: zod_1.z.string(),
            amount: zod_1.z.number().positive(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const emi = await prisma_1.default.emiSchedule.findUnique({ where: { id: emiId } });
        if (!emi) {
            res.status(404).json({ success: false, message: "EMI not found" });
            return;
        }
        const paidAmount = Number(emi.paidAmount) + amount;
        const status = paidAmount >= Number(emi.totalEmi) ? "paid" : "partial";
        const updated = await prisma_1.default.emiSchedule.update({
            where: { id: emiId },
            data: { paidAmount, paidAt: status === "paid" ? new Date() : undefined, status },
        });
        res.json({ success: true, emi: updated });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/loans/:id/write-off
router.post("/:id/write-off", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { writeOffAmount, remarks } = zod_1.z.object({ writeOffAmount: zod_1.z.number().positive(), remarks: zod_1.z.string().optional() }).parse(req.body);
        const loan = await prisma_1.default.loan.update({
            where: { id: req.params.id },
            data: { status: "written-off", writeOffDate: new Date(), writeOffAmount },
        });
        res.json({ success: true, loan });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=loans.js.map