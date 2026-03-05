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
const coa_rules_1 = require("../../lib/coa-rules");
const router = (0, express_1.Router)();
// ─── Helper: Compute DPD for a loan ─────────────────────────────────────────
function computeDpd(overdueEmi) {
    if (!overdueEmi)
        return 0;
    const today = new Date();
    const diff = today.getTime() - overdueEmi.dueDate.getTime();
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}
function npaCategory(dpd) {
    if (dpd < 30)
        return "standard";
    if (dpd < 60)
        return "sma_0";
    if (dpd < 90)
        return "sma_1";
    if (dpd < 365)
        return "sub_standard";
    if (dpd < 730)
        return "doubtful_1";
    if (dpd < 1095)
        return "doubtful_2";
    return "doubtful_3";
}
// ─── GET /api/v1/loans/eligibility/:memberId ─────────────────────────────────
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
// ─── POST /api/v1/loans/applications ─────────────────────────────────────────
router.post("/applications", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            memberId: zod_1.z.string(),
            loanType: zod_1.z.enum(["personal", "agricultural", "business", "housing", "education", "gold"]),
            // COA: loan sub-type
            loanSubType: zod_1.z.enum([
                "kcc", "crop", "livestock", "gold", "lad", "shg", "msme",
                "housing", "staff", "micro", "personal"
            ]).optional(),
            amountRequested: zod_1.z.number().positive(),
            purpose: zod_1.z.string().optional(),
            tenureMonths: zod_1.z.number().int().positive(),
            moratoriumMonths: zod_1.z.number().int().min(0).default(0),
            // COA: special loan fields
            goldValue: zod_1.z.number().positive().optional(), // gold loan appraised value
            collateralFdrId: zod_1.z.string().optional(), // LAD: FDR collateral
            householdIncome: zod_1.z.number().positive().optional(), // microfinance: declared income
        }).parse(req.body);
        // ── COA: Gold loan LTV check (max 75%) ───────────────────────────────
        if (data.loanSubType === "gold" || data.loanType === "gold") {
            if (!data.goldValue) {
                res.status(400).json({ success: false, message: "Gold value is required for gold loans" });
                return;
            }
            const maxAllowed = data.goldValue * coa_rules_1.GOLD_LOAN_MAX_LTV;
            if (data.amountRequested > maxAllowed) {
                res.status(400).json({
                    success: false,
                    message: `Gold loan LTV exceeded: max ₹${maxAllowed.toFixed(2)} (${(coa_rules_1.GOLD_LOAN_MAX_LTV * 100)}% of gold value ₹${data.goldValue})`,
                    maxAllowed,
                    goldValue: data.goldValue,
                    ltvPercent: ((data.amountRequested / data.goldValue) * 100).toFixed(1),
                });
                return;
            }
        }
        // ── COA: Loan Against FDR — max 90% of FDR face value ───────────────
        if (data.loanSubType === "lad" || data.collateralFdrId) {
            const fdr = await prisma_1.default.deposit.findFirst({
                where: { id: data.collateralFdrId, tenantId, depositType: "fd" },
            });
            if (!fdr) {
                res.status(400).json({ success: false, message: "Collateral FDR not found for LAD" });
                return;
            }
            if (fdr.lienLoanId) {
                res.status(400).json({ success: false, message: "FDR already has an active lien" });
                return;
            }
            const maxLad = Number(fdr.principal) * coa_rules_1.LAD_MAX_RATIO;
            if (data.amountRequested > maxLad) {
                res.status(400).json({
                    success: false,
                    message: `LAD amount exceeds 90% of FDR: max ₹${maxLad.toFixed(2)}`,
                    maxAllowed: maxLad,
                });
                return;
            }
        }
        // ── COA: Microfinance — EMI ≤ 50% of household income / 12 ──────────
        if (data.loanSubType === "micro" || data.loanSubType === "shg") {
            if (!data.householdIncome) {
                res.status(400).json({ success: false, message: "Household income required for microfinance loans" });
                return;
            }
            const estMonthlyEmi = (data.amountRequested / data.tenureMonths) * 1.12; // rough incl. interest
            const incomeCapPerMonth = (data.householdIncome / 12) * coa_rules_1.MICROFINANCE_REPAYMENT_CAP;
            if (estMonthlyEmi > incomeCapPerMonth) {
                res.status(400).json({
                    success: false,
                    message: `EMI ₹${estMonthlyEmi.toFixed(0)} exceeds 50% of monthly household income (₹${incomeCapPerMonth.toFixed(0)})`,
                    householdIncome: data.householdIncome,
                    maxEmi: incomeCapPerMonth,
                });
                return;
            }
        }
        // LN-002: Run eligibility rule engine
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
        const riskScore = Math.random() * 100;
        const riskCategory = riskScore > 70 ? "LOW" : riskScore > 40 ? "MEDIUM" : "HIGH";
        const application = await prisma_1.default.loanApplication.create({
            data: {
                tenantId,
                memberId: data.memberId,
                loanType: data.loanType,
                amountRequested: data.amountRequested,
                purpose: data.purpose,
                tenureMonths: data.tenureMonths,
                moratoriumMonths: data.moratoriumMonths,
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
// ─── GET /api/v1/loans/applications ──────────────────────────────────────────
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
// ─── POST /api/v1/loans/applications/:id/approve ─────────────────────────────
router.post("/applications/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
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
// ─── POST /api/v1/loans/applications/:id/reject ──────────────────────────────
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
// ─── POST /api/v1/loans/applications/:id/disburse ────────────────────────────
router.post("/applications/:id/disburse", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { disbursedAmount, interestRate, loanSubType, goldValue, collateralFdrId, householdIncome } = zod_1.z.object({
            disbursedAmount: zod_1.z.number().positive(),
            interestRate: zod_1.z.number().positive(),
            // COA fields
            loanSubType: zod_1.z.string().optional(),
            goldValue: zod_1.z.number().positive().optional(),
            collateralFdrId: zod_1.z.string().optional(),
            householdIncome: zod_1.z.number().positive().optional(),
        }).parse(req.body);
        const application = await prisma_1.default.loanApplication.findUnique({ where: { id: req.params.id } });
        if (!application || application.status !== "approved") {
            res.status(400).json({ success: false, message: "Application not in approved state" });
            return;
        }
        // COA: Determine GL code from subtype
        const glCode = coa_rules_1.LOAN_GL_CODES[loanSubType ?? ""] ?? coa_rules_1.LOAN_GL_CODES["personal"];
        // COA: KCC subvention rate
        const subventionRate = (loanSubType === "kcc") ? coa_rules_1.KCC_SUBVENTION_RATE : undefined;
        const count = await prisma_1.default.loan.count({ where: { tenantId } });
        const loanNumber = `L${String(count + 1).padStart(7, "0")}`;
        const period = (0, gl_posting_1.currentPeriod)();
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
                    npaCategory: "standard",
                    // COA fields
                    loanSubType: loanSubType ?? null,
                    glCode,
                    subventionRate: subventionRate ?? null,
                    goldValue: goldValue ?? null,
                    collateralFdrId: collateralFdrId ?? null,
                    householdIncome: householdIncome ?? null,
                },
            });
            await tx.emiSchedule.createMany({
                data: emiScheduleData.map((e) => ({ ...e, loanId: newLoan.id })),
            });
            await tx.loanApplication.update({ where: { id: req.params.id }, data: { status: "disbursed" } });
            return newLoan;
        });
        // COA: GL posting for disbursement (DR loan account / CR cash)
        await (0, gl_posting_1.postGl)(tenantId, "LOAN_DISBURSEMENT", disbursedAmount, `Loan disbursement — ${loanNumber} (${loanSubType ?? application.loanType})`, period);
        // COA: If LAD, auto-mark FDR lien
        if (collateralFdrId) {
            await prisma_1.default.deposit.update({
                where: { id: collateralFdrId },
                data: { lienLoanId: loan.id, status: "lien_marked" },
            });
        }
        // COA: If KCC, book subvention receivable
        if (loanSubType === "kcc" && subventionRate) {
            const subventionAmount = Math.round(disbursedAmount * Number(subventionRate) * 100) / 100;
            if (subventionAmount > 0) {
                await (0, gl_posting_1.postGl)(tenantId, "KCC_SUBVENTION", subventionAmount, `KCC subvention 3% — ${loanNumber}`, period);
            }
        }
        res.status(201).json({ success: true, loan, glCode });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/loans ───────────────────────────────────────────────────────
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status, memberId, npaCategory: npaFilter, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (status)
            where.status = status;
        if (memberId)
            where.memberId = memberId;
        if (npaFilter)
            where.npaCategory = npaFilter;
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
// ─── GET /api/v1/loans/:id ───────────────────────────────────────────────────
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
// ─── POST /api/v1/loans/:id/emi/pay — Pay EMI with GL split ─────────────────
router.post("/:id/emi/pay", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const { emiId, amount, remarks } = zod_1.z.object({
            emiId: zod_1.z.string(),
            amount: zod_1.z.number().positive(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const emi = await prisma_1.default.emiSchedule.findUnique({
            where: { id: emiId },
            include: { loan: true },
        });
        if (!emi || emi.loan.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "EMI not found" });
            return;
        }
        const paidAmount = Number(emi.paidAmount) + amount;
        const status = paidAmount >= Number(emi.totalEmi) ? "paid" : "partial";
        const updated = await prisma_1.default.emiSchedule.update({
            where: { id: emiId },
            data: { paidAmount, paidAt: status === "paid" ? new Date() : undefined, status },
        });
        // COA: GL postings — split into principal, interest, penal
        const principalPaid = Math.min(amount, Number(emi.principal));
        const interestPaid = Math.min(Math.max(0, amount - principalPaid), Number(emi.interest));
        const penalPaid = Math.max(0, amount - principalPaid - interestPaid);
        if (principalPaid > 0) {
            await (0, gl_posting_1.postGl)(tenantId, "LOAN_REPAYMENT_PRINCIPAL", principalPaid, `EMI principal repayment — ${emi.loan.loanNumber} #${emi.installmentNo}`, period);
        }
        if (interestPaid > 0) {
            await (0, gl_posting_1.postGl)(tenantId, "LOAN_REPAYMENT_INTEREST", interestPaid, `EMI interest repayment — ${emi.loan.loanNumber} #${emi.installmentNo}`, period);
        }
        if (penalPaid > 0) {
            await (0, gl_posting_1.postGl)(tenantId, "PENAL_INTEREST", penalPaid, `Penal interest — ${emi.loan.loanNumber} #${emi.installmentNo}`, period);
        }
        // Update outstanding principal/interest on loan
        await prisma_1.default.loan.update({
            where: { id: emi.loanId },
            data: {
                outstandingPrincipal: Math.max(0, Number(emi.loan.outstandingPrincipal) - principalPaid),
                outstandingInterest: Math.max(0, Number(emi.loan.outstandingInterest) - interestPaid),
                outstandingPenal: Math.max(0, Number(emi.loan.outstandingPenal) - penalPaid),
            },
        });
        res.json({ success: true, emi: updated, split: { principalPaid, interestPaid, penalPaid } });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/loans/:id/preclosure — Pre-close loan ─────────────────────
router.post("/:id/preclosure", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const loan = await prisma_1.default.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan || loan.status !== "active") {
            res.status(404).json({ success: false, message: "Active loan not found" });
            return;
        }
        const outstanding = Number(loan.outstandingPrincipal);
        // COA: Pre-closure charge — 1–2% of outstanding principal
        const chargeRate = coa_rules_1.PRECLOSURE_CHARGE_MIN +
            (coa_rules_1.PRECLOSURE_CHARGE_MAX - coa_rules_1.PRECLOSURE_CHARGE_MIN) * 0.5; // default 1.5%
        const preclosureCharge = Math.round(outstanding * chargeRate * 100) / 100;
        await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: { status: "closed" },
        });
        // COA: GL for pre-closure fee
        await (0, gl_posting_1.postGl)(tenantId, "LOAN_PRECLOSURE", preclosureCharge, `Pre-closure charge — ${loan.loanNumber}`, period);
        // If LAD — clear FDR lien
        if (loan.collateralFdrId) {
            await prisma_1.default.deposit.update({
                where: { id: loan.collateralFdrId },
                data: { lienLoanId: null, status: "active" },
            });
        }
        res.json({
            success: true,
            message: "Loan pre-closed",
            outstandingPrincipal: outstanding,
            preclosureCharge,
            chargeRate: `${(chargeRate * 100).toFixed(1)}%`,
            lienCleared: !!loan.collateralFdrId,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/loans/:id/write-off — Write off loan ──────────────────────
router.post("/:id/write-off", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const { writeOffAmount, bodResolutionRef, remarks } = zod_1.z.object({
            writeOffAmount: zod_1.z.number().positive(),
            bodResolutionRef: zod_1.z.string().min(1, "BOD resolution reference is required for write-off"),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        // COA: Write-off only allowed if fully provisioned (Loss Asset category)
        if (loan.npaCategory !== "loss") {
            res.status(400).json({
                success: false,
                message: "Write-off requires loan to be classified as Loss Asset. Current classification: " + (loan.npaCategory ?? "standard"),
                currentCategory: loan.npaCategory,
            });
            return;
        }
        // COA: BOD resolution reference required
        if (!bodResolutionRef) {
            res.status(400).json({ success: false, message: "BOD resolution reference number is mandatory for write-off" });
            return;
        }
        await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: {
                status: "written-off",
                writeOffDate: new Date(),
                writeOffAmount,
                bodResolutionRef,
            },
        });
        // COA: GL — DR Provision (04-02-0006) / CR Loan Outstanding
        await (0, gl_posting_1.postGl)(tenantId, "WRITE_OFF", writeOffAmount, `Loan write-off — ${loan.loanNumber} | BOD Res: ${bodResolutionRef}`, period);
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "LOAN_WRITE_OFF",
            entity: "Loan",
            entityId: loan.id,
            newData: { writeOffAmount, bodResolutionRef, remarks },
        });
        res.json({ success: true, message: "Loan written off", writeOffAmount, bodResolutionRef });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/loans/:id/recovery — Post write-off recovery ──────────────
router.post("/:id/recovery", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const { amount, remarks } = zod_1.z.object({
            amount: zod_1.z.number().positive(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan || loan.status !== "written-off") {
            res.status(400).json({ success: false, message: "Loan must be written-off to record recovery" });
            return;
        }
        const newRecovered = Number(loan.recoveredAmount ?? 0) + amount;
        await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: { recoveredAmount: newRecovered },
        });
        // COA: Recovery on cash basis → GL 11-01-0001
        await (0, gl_posting_1.postGl)(tenantId, "RECOVERY_WRITTEN_OFF", amount, `Recovery from written-off loan — ${loan.loanNumber}`, period);
        res.json({
            success: true,
            message: "Recovery recorded",
            recoveredAmount: amount,
            totalRecovered: newRecovered,
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
// ─── POST /api/v1/loans/:id/subvention — Record KCC subvention receipt ──────
router.post("/:id/subvention", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const { amount, remarks } = zod_1.z.object({
            amount: zod_1.z.number().positive(),
            remarks: zod_1.z.string().optional(),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan || loan.loanSubType !== "kcc") {
            res.status(400).json({ success: false, message: "Subvention only applicable to KCC loans" });
            return;
        }
        // COA: Book to GL 10-02-0004 (Subvention Income)
        await (0, gl_posting_1.postGl)(tenantId, "KCC_SUBVENTION", amount, `KCC subvention receipt — ${loan.loanNumber}`, period);
        res.json({ success: true, message: "Subvention income recorded", amount });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/loans/:id/npa-category — Manually set Loss Asset ──────────
router.post("/:id/npa-category", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { npaCategory: cat } = zod_1.z.object({
            npaCategory: zod_1.z.enum(["standard", "sma_0", "sma_1", "sub_standard", "doubtful_1", "doubtful_2", "doubtful_3", "loss"]),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: { npaCategory: cat, npaDate: cat === "standard" ? null : (loan.npaDate ?? new Date()) },
        });
        res.json({ success: true, message: `NPA category updated to ${cat}`, loanId: loan.id });
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
//# sourceMappingURL=loans.js.map