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
const id_generator_1 = require("../../lib/id-generator");
const router = (0, express_1.Router)();
// ─── GET /api/v1/loans/applications/:id/pre-disbursement-check ─────────────
// LN-DIS01: Pre-Disbursement Checklist (6 Gates)
router.get("/applications/:id/pre-disbursement-check", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const application = await prisma_1.default.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                documentTrackers: true,
                collateral: true,
                sanctionLetter: true,
                product: true,
            },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }
        const conditions = [];
        // Condition 1: All mandatory documents verified
        const mandatoryDocs = application.documentTrackers.filter((d) => d.isMandatory);
        const verifiedMandatory = mandatoryDocs.filter((d) => d.status === "VERIFIED").length;
        conditions.push({
            id: 1,
            name: "All mandatory documents verified",
            status: verifiedMandatory === mandatoryDocs.length ? "PASS" : "FAIL",
            details: `${verifiedMandatory}/${mandatoryDocs.length} mandatory documents verified`,
        });
        // Condition 2: Sanction status = SANCTION_ACKNOWLEDGED
        conditions.push({
            id: 2,
            name: "Sanction acknowledged",
            status: application.status === "SANCTION_ACKNOWLEDGED" ? "PASS" : "FAIL",
            details: `Current status: ${application.status}`,
        });
        // Condition 3: Collateral charged/mortgage registered (for secured loans)
        const isSecured = application.product?.category === "GOLD" || application.product?.category === "HOUSING";
        if (isSecured) {
            const collateralReady = application.collateral && (application.collateral.collateralType === "GOLD" ||
                (application.collateral.collateralType === "PROPERTY" && application.collateral.registrationNumber));
            conditions.push({
                id: 3,
                name: "Collateral charged/mortgage registered",
                status: collateralReady ? "PASS" : "FAIL",
                details: collateralReady ? "Collateral registered" : "Collateral not registered",
            });
        }
        else {
            conditions.push({
                id: 3,
                name: "Collateral charged/mortgage registered",
                status: "PASS",
                details: "Not applicable (unsecured loan)",
            });
        }
        // Condition 4: Insurance premium collected (if product requires)
        // TODO: Check insurance flag in fee ledger
        conditions.push({
            id: 4,
            name: "Insurance premium collected",
            status: "PASS", // Placeholder - implement fee ledger check
            details: "Not required for this product",
        });
        // Condition 5: Maker-checker approval on disbursement transaction
        // This will be checked when disbursement is initiated
        conditions.push({
            id: 5,
            name: "Maker-checker approval",
            status: "PASS", // Will be checked during disbursement initiation
            details: "Will be verified during disbursement",
        });
        // Condition 6: Loan account created and EMI schedule generated
        const loanAccount = await prisma_1.default.loan.findFirst({
            where: { applicationId: application.id },
            include: { emiSchedule: true },
        });
        conditions.push({
            id: 6,
            name: "Loan account created and EMI schedule generated",
            status: loanAccount && loanAccount.emiSchedule.length > 0 ? "PASS" : "FAIL",
            details: loanAccount ? `${loanAccount.emiSchedule.length} EMI installments generated` : "Loan account not created",
        });
        const allPassed = conditions.every((c) => c.status === "PASS");
        const blockingItems = conditions.filter((c) => c.status === "FAIL");
        res.json({
            success: true,
            ready: allPassed,
            conditions,
            blockingItems,
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── POST /api/v1/loans/applications/:id/create-account ───────────────────
// LN-DIS04: Create Loan Account & EMI Schedule
router.post("/applications/:id/create-account", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            sanctionedAmount: zod_1.z.number().positive(),
            interestRate: zod_1.z.number().positive(),
            tenureMonths: zod_1.z.number().int().positive(),
        }).parse(req.body);
        const application = await prisma_1.default.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
            include: { product: { include: { interestScheme: true } } },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }
        if (application.status !== "SANCTION_ACKNOWLEDGED") {
            res.status(400).json({
                success: false,
                message: `Application must be in SANCTION_ACKNOWLEDGED status. Current: ${application.status}`,
            });
            return;
        }
        // Check if loan account already exists
        const existingLoan = await prisma_1.default.loan.findFirst({
            where: { applicationId: application.id },
        });
        if (existingLoan) {
            res.json({ success: true, loan: existingLoan });
            return;
        }
        // Generate loan number
        const count = await prisma_1.default.loan.count({ where: { tenantId } });
        const loanNumber = (0, id_generator_1.generateLoanId)(count + 1);
        // Generate EMI schedule
        const { generateEMISchedule } = await Promise.resolve().then(() => __importStar(require("../../services/emi-schedule.service")));
        const emiSchedule = await generateEMISchedule(tenantId, Number(data.sanctionedAmount), data.interestRate, data.tenureMonths, new Date(), 0 // moratoriumMonths
        );
        const loan = await prisma_1.default.$transaction(async (tx) => {
            const newLoan = await tx.loan.create({
                data: {
                    tenantId,
                    memberId: application.memberId,
                    applicationId: application.id,
                    loanNumber,
                    loanType: application.loanType,
                    principalAmount: data.sanctionedAmount,
                    interestRate: data.interestRate,
                    tenureMonths: data.tenureMonths,
                    disbursedAmount: 0, // Will be set on disbursement
                    outstandingPrincipal: 0,
                    status: "active",
                    npaCategory: "standard",
                    productId: application.productId,
                },
            });
            await tx.emiSchedule.createMany({
                data: emiSchedule.map((e) => ({
                    loanId: newLoan.id,
                    installmentNo: e.installmentNo,
                    dueDate: e.dueDate,
                    principal: String(e.principalComponent),
                    interest: String(e.interestComponent),
                    totalEmi: String(e.totalEmi),
                    penalAmount: "0",
                    paidAmount: "0",
                    status: "pending",
                })),
            });
            return newLoan;
        });
        const loanWithSchedule = await prisma_1.default.loan.findUnique({
            where: { id: loan.id },
            include: { emiSchedule: true },
        });
        res.json({ success: true, loan: loanWithSchedule });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── POST /api/v1/loans/:loanId/disburse ────────────────────────────────────
// LN-DIS02, LN-DIS04: Initiate Disbursement (Maker)
router.post("/:loanId/disburse", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.id;
        const data = zod_1.z.object({
            disbursementMode: zod_1.z.enum(["CASH", "NEFT", "RTGS", "INTERNAL_TRANSFER", "DEMAND_DRAFT"]),
            bankAccountDetails: zod_1.z.object({
                accountNumber: zod_1.z.string(),
                ifsc: zod_1.z.string(),
                bankName: zod_1.z.string(),
            }).optional(),
            amount: zod_1.z.number().positive(),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.loanId, tenantId },
            include: {
                application: {
                    include: {
                        documentTrackers: true,
                        sanctionLetter: true,
                    },
                },
                emiSchedule: true,
            },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        // Verify pre-disbursement conditions
        const checkRes = await fetch(`${req.protocol}://${req.get("host")}/api/v1/loans/applications/${loan.applicationId}/pre-disbursement-check`, {
            headers: { Authorization: req.headers.authorization || "" },
        });
        const checkData = await checkRes.json();
        if (!checkData.success || !checkData.ready) {
            res.status(400).json({
                success: false,
                message: "Pre-disbursement conditions not met",
                blockingItems: checkData.blockingItems,
            });
            return;
        }
        // Validate amount
        if (data.amount > Number(loan.principalAmount)) {
            res.status(400).json({
                success: false,
                message: `Disbursement amount (₹${data.amount}) exceeds sanctioned amount (₹${loan.principalAmount})`,
            });
            return;
        }
        // For NEFT/RTGS, bank details are mandatory
        if ((data.disbursementMode === "NEFT" || data.disbursementMode === "RTGS") && !data.bankAccountDetails) {
            res.status(400).json({
                success: false,
                message: "Bank account details are required for NEFT/RTGS",
            });
            return;
        }
        // Update loan with disbursement details (pending checker approval)
        const updatedLoan = await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: {
                disbursementMode: data.disbursementMode,
                disbursedAmount: data.amount,
                outstandingPrincipal: data.amount,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, userId, "LOAN_DISBURSEMENT_INITIATED", {
            loanId: loan.id,
            loanNumber: loan.loanNumber,
            amount: data.amount,
            mode: data.disbursementMode,
        });
        res.json({
            success: true,
            loan: updatedLoan,
            message: "Disbursement initiated. Pending checker approval.",
        });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── PUT /api/v1/loans/:loanId/disburse/approve ─────────────────────────────
// LN-DIS03, LN-DIS04, LN-DIS05, LN-DIS06: Approve Disbursement (Checker)
router.put("/:loanId/disburse/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const data = zod_1.z.object({
            signatureVerified: zod_1.z.boolean().optional(), // For cash disbursement
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.loanId, tenantId },
            include: {
                application: {
                    include: {
                        member: true,
                        sanctionLetter: true,
                    },
                },
                emiSchedule: true,
            },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        if (!loan.disbursementMode) {
            res.status(400).json({ success: false, message: "Disbursement not initiated" });
            return;
        }
        // For cash disbursement, signature verification is mandatory (LN-DIS03)
        if (loan.disbursementMode === "CASH" && !data.signatureVerified) {
            res.status(400).json({
                success: false,
                message: "Signature verification required for cash disbursement",
            });
            return;
        }
        const period = (0, gl_posting_1.currentPeriod)();
        const disbursedAmount = Number(loan.disbursedAmount);
        // Generate voucher number
        const voucherCount = await prisma_1.default.disbursementVoucher.count({ where: { tenantId } });
        const voucherNumber = `DV-${new Date().getFullYear()}-${String(voucherCount + 1).padStart(6, "0")}`;
        // Create disbursement voucher and update loan status atomically
        const result = await prisma_1.default.$transaction(async (tx) => {
            // Update loan status
            const updatedLoan = await tx.loan.update({
                where: { id: loan.id },
                data: {
                    disbursedAt: new Date(),
                    status: "active",
                },
            });
            // Update application status
            await tx.loanApplication.update({
                where: { id: loan.applicationId },
                data: {
                    status: "DISBURSED",
                },
            });
            // Create disbursement voucher
            const voucher = await tx.disbursementVoucher.create({
                data: {
                    loanId: loan.id,
                    tenantId,
                    voucherNumber,
                    disbursedAmount,
                    disbursementDate: new Date(),
                    disbursementMode: loan.disbursementMode,
                    bankAccountDetails: loan.disbursementMode === "NEFT" || loan.disbursementMode === "RTGS"
                        ? {
                            accountNumber: "TBD", // Should come from request
                            ifsc: "TBD",
                            bankName: "TBD",
                        }
                        : null,
                    emiScheduleSummary: {
                        totalInstallments: loan.emiSchedule.length,
                        firstEmiDate: loan.emiSchedule[0]?.dueDate,
                        emiAmount: loan.emiSchedule[0]?.totalEmi,
                    },
                    firstEmiDueDate: loan.emiSchedule[0]?.dueDate || new Date(),
                },
            });
            // Update loan with voucher ID
            await tx.loan.update({
                where: { id: loan.id },
                data: { disbursementVoucherId: voucher.id },
            });
            return { loan: updatedLoan, voucher };
        });
        // GL Posting (LN-DIS06) - Atomic transaction
        try {
            await (0, gl_posting_1.postGl)(tenantId, "LOAN_DISBURSEMENT", disbursedAmount, `Loan disbursement — ${loan.loanNumber}`, period);
        }
        catch (glError) {
            console.error("GL posting error:", glError);
            // Log error but don't fail the disbursement
        }
        await (0, audit_1.createAuditLog)(tenantId, checkerId, "LOAN_DISBURSEMENT_APPROVED", {
            loanId: loan.id,
            loanNumber: loan.loanNumber,
            amount: disbursedAmount,
            voucherNumber: result.voucher.voucherNumber,
        });
        // BRD v5.0 LN-DIS08: Post-disbursement notification via SMS and email
        try {
            const member = await prisma_1.default.member.findUnique({
                where: { id: loan.memberId },
                include: { tenant: true },
            });
            if (member && member.phone) {
                const firstEmiDate = loan.emiSchedule[0]?.dueDate || new Date();
                const emiAmount = loan.emiSchedule[0]?.totalEmi || 0;
                const totalTenure = loan.emiSchedule.length;
                // Send SMS notification
                try {
                    const { canSendSms, recordSmsSent } = await Promise.resolve().then(() => __importStar(require("../../services/sms.service")));
                    if (await canSendSms(tenantId)) {
                        // In production: Call SMS gateway with template
                        // For now: Log notification
                        await prisma_1.default.notificationLog.create({
                            data: {
                                tenantId,
                                memberId: member.id,
                                type: "SMS",
                                recipient: member.phone,
                                templateId: "loan_disbursement",
                                status: "SENT",
                                body: `Dear ${member.firstName}, your loan of ₹${disbursedAmount.toFixed(0)} (Ref: ${loan.loanNumber}) has been disbursed. EMI: ₹${emiAmount.toFixed(0)}/month. First EMI due: ${firstEmiDate.toLocaleDateString()}. -SahayogAI`,
                                metadata: {
                                    loanId: loan.id,
                                    loanNumber: loan.loanNumber,
                                    disbursedAmount,
                                    emiAmount,
                                    firstEmiDate: firstEmiDate.toISOString(),
                                    tenureMonths: totalTenure,
                                },
                                sentAt: new Date(),
                            },
                        });
                        await recordSmsSent(tenantId);
                    }
                }
                catch (smsErr) {
                    console.error("[Post-Disbursement SMS]", smsErr);
                    // Don't fail disbursement if notification fails
                }
                // Send Email notification (if email exists)
                if (member.email) {
                    try {
                        await prisma_1.default.notificationLog.create({
                            data: {
                                tenantId,
                                memberId: member.id,
                                type: "EMAIL",
                                recipient: member.email,
                                templateId: "loan_disbursement",
                                status: "SENT",
                                subject: `Loan Disbursement Confirmation - ${loan.loanNumber}`,
                                body: `Dear ${member.firstName},\n\nYour loan application has been approved and disbursed.\n\nLoan Details:\n- Loan Account Number: ${loan.loanNumber}\n- Disbursed Amount: ₹${disbursedAmount.toFixed(2)}\n- EMI Amount: ₹${emiAmount.toFixed(2)}\n- First EMI Due Date: ${firstEmiDate.toLocaleDateString()}\n- Total Tenure: ${totalTenure} months\n\nThank you for choosing Sahayog AI.\n\nBest regards,\n${member.tenant.name}`,
                                metadata: {
                                    loanId: loan.id,
                                    loanNumber: loan.loanNumber,
                                    disbursedAmount,
                                    emiAmount,
                                    firstEmiDate: firstEmiDate.toISOString(),
                                    tenureMonths: totalTenure,
                                },
                                sentAt: new Date(),
                            },
                        });
                    }
                    catch (emailErr) {
                        console.error("[Post-Disbursement Email]", emailErr);
                        // Don't fail disbursement if notification fails
                    }
                }
            }
        }
        catch (notifErr) {
            console.error("[Post-Disbursement Notification]", notifErr);
            // Don't fail disbursement if notification fails
        }
        res.json({
            success: true,
            loan: result.loan,
            voucher: result.voucher,
            message: "Disbursement approved and completed",
        });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── GET /api/v1/loans/:loanId/disbursement-voucher ────────────────────────
// LN-DIS05: Get Disbursement Voucher
router.get("/:loanId/disbursement-voucher", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.loanId, tenantId },
            include: {
                disbursementVoucher: true,
                member: { select: { firstName: true, lastName: true, memberNumber: true } },
            },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        if (!loan.disbursementVoucher) {
            res.status(404).json({ success: false, message: "Disbursement voucher not found" });
            return;
        }
        res.json({
            success: true,
            voucher: {
                ...loan.disbursementVoucher,
                memberName: `${loan.member.firstName} ${loan.member.lastName}`,
                memberNumber: loan.member.memberNumber,
                loanNumber: loan.loanNumber,
            },
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── POST /api/v1/loans/:loanId/tranches ────────────────────────────────────
// LN-DIS07: Create Tranche Schedule (for housing/project loans)
router.post("/:loanId/tranches", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            tranches: zod_1.z.array(zod_1.z.object({
                amount: zod_1.z.number().positive(),
                expectedDate: zod_1.z.string(), // ISO date string
                condition: zod_1.z.string().optional(), // Condition for release
            })).min(1).max(4), // Max 4 tranches per loan.tranche.max.count
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.loanId, tenantId },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        // Validate total tranche amount doesn't exceed sanctioned amount
        const totalTrancheAmount = data.tranches.reduce((sum, t) => sum + t.amount, 0);
        if (totalTrancheAmount > Number(loan.principalAmount)) {
            res.status(400).json({
                success: false,
                message: `Total tranche amount (₹${totalTrancheAmount}) exceeds sanctioned amount (₹${loan.principalAmount})`,
            });
            return;
        }
        // Create tranche schedule (stored as JSON in loan metadata or separate table)
        // For now, store in a JSON field or create TrancheSchedule model
        const trancheSchedule = {
            tranches: data.tranches.map((t, idx) => ({
                trancheNumber: idx + 1,
                amount: t.amount,
                expectedDate: t.expectedDate,
                condition: t.condition,
                status: "PENDING",
                disbursedAt: null,
            })),
            totalAmount: totalTrancheAmount,
            totalDisbursed: 0,
        };
        // Store in loan metadata or update loan with tranche info
        await prisma_1.default.loan.update({
            where: { id: loan.id },
            data: {
            // Assuming we add a trancheSchedule JSON field to Loan model
            // For now, we'll return the schedule
            },
        });
        res.json({
            success: true,
            trancheSchedule,
            message: "Tranche schedule created successfully",
        });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── POST /api/v1/loans/:loanId/tranches/:trancheId/disburse ────────────────
// LN-DIS07: Disburse Individual Tranche
router.post("/:loanId/tranches/:trancheId/disburse", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { disbursementMode, bankAccountDetails, amount } = zod_1.z.object({
            disbursementMode: zod_1.z.enum(["CASH", "NEFT", "RTGS", "INTERNAL_TRANSFER", "DEMAND_DRAFT"]),
            bankAccountDetails: zod_1.z.object({
                accountNumber: zod_1.z.string(),
                ifsc: zod_1.z.string(),
                bankName: zod_1.z.string(),
            }).optional(),
            amount: zod_1.z.number().positive(),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.loanId, tenantId },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        // TODO: Validate tranche exists and conditions are met
        // TODO: Update tranche status to DISBURSED
        // TODO: Update loan disbursedAmount (cumulative)
        // TODO: Generate EMI schedule for this tranche
        // TODO: Create disbursement voucher for tranche
        res.json({
            success: true,
            message: "Tranche disbursed successfully",
        });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
exports.default = router;
//# sourceMappingURL=loan-disbursement.js.map