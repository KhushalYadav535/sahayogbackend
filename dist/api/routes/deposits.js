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
const gl_posting_1 = require("../../lib/gl-posting");
const coa_rules_1 = require("../../lib/coa-rules");
const router = (0, express_1.Router)();
// ─── Helpers ────────────────────────────────────────────────────────────────
function isSeniorCitizen(dateOfBirth) {
    if (!dateOfBirth)
        return false;
    const today = new Date();
    const age = today.getFullYear() - dateOfBirth.getFullYear() -
        (today < new Date(today.getFullYear(), dateOfBirth.getMonth(), dateOfBirth.getDate()) ? 1 : 0);
    return age >= coa_rules_1.SENIOR_CITIZEN_AGE;
}
// ─── POST /api/v1/deposits — Create FDR/RD/MIS ─────────────────────────────
router.post("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const schema = zod_1.z.object({
            memberId: zod_1.z.string(),
            depositType: zod_1.z.enum(["fd", "rd", "mis"]),
            principal: zod_1.z.number().positive(),
            interestRate: zod_1.z.number().min(0).max(20),
            tenureMonths: zod_1.z.number().int().positive(),
            compoundingFreq: zod_1.z.enum(["monthly", "quarterly", "half_yearly", "yearly"]).default("quarterly"),
            rdMonthlyAmount: zod_1.z.number().positive().optional(),
            form15Exempt: zod_1.z.boolean().optional(),
        });
        const data = schema.parse(req.body);
        // Validate member
        const member = await prisma_1.default.member.findFirst({
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
        const tdsInfo = (0, coa_rules_1.computeTds)(annual, senior, !!member.panNumber, data.form15Exempt ?? false);
        // DA-001: Generate deposit number - FDR-YYYY-NNNNNN format (for FDR), RD-YYYY-NNNNNN (for RD), MIS-YYYY-NNNNNN (for MIS)
        const count = await prisma_1.default.deposit.count({ where: { tenantId } });
        const { generateFdrAccountId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
        const depositNumber = data.depositType === "fd"
            ? generateFdrAccountId(count + 1)
            : `${data.depositType.toUpperCase()}-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;
        const openedAt = new Date();
        const maturityDate = new Date(openedAt);
        maturityDate.setMonth(maturityDate.getMonth() + data.tenureMonths);
        // DEP-003: Configurable compounding frequency calculation
        // Formula: A = P × (1 + r/n)^(n×t)
        // where: P = principal, r = annual rate, n = compounding frequency per year, t = years
        let n;
        if (data.compoundingFreq === "monthly") {
            n = 12;
        }
        else if (data.compoundingFreq === "quarterly") {
            n = 4;
        }
        else if (data.compoundingFreq === "half_yearly") {
            n = 2;
        }
        else if (data.compoundingFreq === "yearly") {
            n = 1;
        }
        else {
            // Simple interest fallback
            n = 0;
        }
        const principal = Number(data.principal);
        const rate = data.interestRate / 100;
        const months = data.tenureMonths;
        const years = months / 12;
        let maturityAmount;
        if (n === 0) {
            // Simple interest: A = P × (1 + r × t)
            maturityAmount = principal * (1 + rate * years);
        }
        else {
            // Compound interest: A = P × (1 + r/n)^(n×t)
            maturityAmount = principal * Math.pow(1 + rate / n, n * years);
        }
        // Determine GL code for deposit type
        const depositGlCode = data.depositType === "fd" ? "FDR_OPEN" :
            data.depositType === "rd" ? "RD_OPEN" : "MIS_OPEN";
        const deposit = await prisma_1.default.deposit.create({
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
        await (0, gl_posting_1.postGl)(tenantId, depositGlCode, Number(data.principal), `${data.depositType.toUpperCase()} opened — ${depositNumber}`, (0, gl_posting_1.currentPeriod)());
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            const issues = err.errors ?? err.issues ?? [];
            const message = issues.map((e) => `${(e.path || []).join(".") || "body"}: ${e.message}`).join("; ");
            res.status(400).json({ success: false, message, errors: issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits ───────────────────────────────────────────────────
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { memberId, status, depositType, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (memberId)
            where.memberId = memberId;
        if (status)
            where.status = status;
        if (depositType)
            where.depositType = depositType;
        const [deposits, total] = await Promise.all([
            prisma_1.default.deposit.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { openedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma_1.default.deposit.count({ where }),
        ]);
        res.json({ success: true, deposits, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits/maturing — Get deposits maturing soon ──────────────
router.get("/maturing", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { days = "30" } = req.query;
        const daysNum = parseInt(days);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() + daysNum);
        const maturingDeposits = await prisma_1.default.deposit.findMany({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits/:id ───────────────────────────────────────────────
router.get("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const deposit = await prisma_1.default.deposit.findFirst({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/deposits/:id/mature — Settle at maturity ─────────────────
router.post("/:id/mature", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { action } = zod_1.z.object({
            action: zod_1.z.enum(["credit_to_sb", "auto_renew", "manual"]).optional(),
        }).parse(req.body);
        const deposit = await prisma_1.default.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: {
                    include: {
                        sbAccounts: { where: { status: "active" }, take: 1 }
                    }
                }
            },
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
        const { tdsAmount } = (0, coa_rules_1.computeTds)(totalInterest, deposit.isSeniorCitizen, !!deposit.member.panNumber, deposit.form15Exempt);
        const netPayable = Number(deposit.principal) + totalInterest - tdsAmount;
        const maturityAction = action || "credit_to_sb"; // Default: credit to SB
        // DEP-007: Auto-Renewal Configuration
        if (maturityAction === "auto_renew" && deposit.depositType === "fd") {
            // Create new FDR with same tenure and current rate - DA-001: FDR-YYYY-NNNNNN format
            const count = await prisma_1.default.deposit.count({ where: { tenantId } });
            const { generateFdrAccountId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
            const newDepositNumber = generateFdrAccountId(count + 1);
            const newMaturityDate = new Date();
            newMaturityDate.setMonth(newMaturityDate.getMonth() + deposit.tenureMonths);
            // Use current rate (could fetch from metadata)
            const currentRate = Number(deposit.interestRate);
            const n = deposit.compoundingFreq === "monthly" ? 12 :
                deposit.compoundingFreq === "quarterly" ? 4 :
                    deposit.compoundingFreq === "half_yearly" ? 2 : 1;
            const newMaturityAmount = netPayable * Math.pow(1 + currentRate / 100 / n, (n * deposit.tenureMonths) / 12);
            const newDeposit = await prisma_1.default.deposit.create({
                data: {
                    tenantId,
                    memberId: deposit.memberId,
                    depositNumber: newDepositNumber,
                    depositType: "fd",
                    principal: netPayable,
                    interestRate: currentRate,
                    tenureMonths: deposit.tenureMonths,
                    compoundingFreq: deposit.compoundingFreq,
                    maturityDate: newMaturityDate,
                    maturityAmount: Math.round(newMaturityAmount * 100) / 100,
                    status: "active",
                    isSeniorCitizen: deposit.isSeniorCitizen,
                    accruedInterest: 0,
                },
            });
            // Close old deposit
            await prisma_1.default.deposit.update({
                where: { id: deposit.id },
                data: {
                    status: "matured",
                    closedAt: new Date(),
                    tdsDeducted: tdsAmount,
                },
            });
            // GL: Renewal (no cash movement, just liability transfer)
            await (0, gl_posting_1.postGl)(tenantId, "FDR_OPEN", netPayable, `FDR auto-renewed — ${newDepositNumber}`, (0, gl_posting_1.currentPeriod)());
            res.json({
                success: true,
                message: "Deposit auto-renewed",
                oldDeposit: deposit.depositNumber,
                newDeposit: {
                    depositNumber: newDepositNumber,
                    principal: netPayable,
                    maturityDate: newMaturityDate,
                    maturityAmount: Math.round(newMaturityAmount * 100) / 100,
                },
            });
            return;
        }
        // Credit to SB account
        if (maturityAction === "credit_to_sb") {
            const sbAccount = deposit.member.sbAccounts[0];
            if (sbAccount) {
                const newBalance = Number(sbAccount.balance) + netPayable;
                await prisma_1.default.sbAccount.update({
                    where: { id: sbAccount.id },
                    data: { balance: newBalance, lastActivityAt: new Date() },
                });
                await prisma_1.default.transaction.create({
                    data: {
                        accountId: sbAccount.id,
                        type: "credit",
                        category: "interest",
                        amount: netPayable,
                        balanceAfter: newBalance,
                        remarks: `FDR maturity — ${deposit.depositNumber}`,
                    },
                });
            }
        }
        await prisma_1.default.deposit.update({
            where: { id: deposit.id },
            data: {
                status: "matured",
                closedAt: new Date(),
                tdsDeducted: tdsAmount,
            },
        });
        // GL: TDS deducted
        if (tdsAmount > 0) {
            await (0, gl_posting_1.postGl)(tenantId, "FDR_TDS_DEDUCTED", tdsAmount, `TDS deducted on maturity — ${deposit.depositNumber}`, (0, gl_posting_1.currentPeriod)());
        }
        // GL: Maturity payout
        await (0, gl_posting_1.postGl)(tenantId, "FDR_MATURE", netPayable, `FDR maturity payout — ${deposit.depositNumber}`, (0, gl_posting_1.currentPeriod)());
        res.json({
            success: true,
            message: "Deposit matured and settled",
            principal: deposit.principal,
            totalInterest,
            tdsDeducted: tdsAmount,
            netPayable: Math.round(netPayable * 100) / 100,
            action: maturityAction,
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
// ─── POST /api/v1/deposits/:id/lien — Mark or clear FDR lien ───────────────
router.post("/:id/lien", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { loanId, action } = zod_1.z.object({
            loanId: zod_1.z.string().optional(),
            action: zod_1.z.enum(["mark", "clear"]),
        }).parse(req.body);
        const deposit = await prisma_1.default.deposit.findFirst({ where: { id: req.params.id, tenantId } });
        if (!deposit) {
            res.status(404).json({ success: false, message: "Deposit not found" });
            return;
        }
        if (action === "mark") {
            if (deposit.lienLoanId) {
                res.status(400).json({ success: false, message: "Deposit already has an active lien" });
                return;
            }
            await prisma_1.default.deposit.update({
                where: { id: deposit.id },
                data: { lienLoanId: loanId ?? null, status: "lien_marked" },
            });
            return res.json({ success: true, message: "Lien marked on deposit" });
        }
        else {
            await prisma_1.default.deposit.update({
                where: { id: deposit.id },
                data: { lienLoanId: null, status: "active" },
            });
            return res.json({ success: true, message: "Lien cleared from deposit" });
        }
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/deposits/:id/withdraw — Premature withdrawal ─────────────
router.post("/:id/withdraw", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const deposit = await prisma_1.default.deposit.findFirst({
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
        // DEP-005: Premature withdrawal penalty matrix
        const holdingMonths = Math.floor((today.getTime() - deposit.openedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
        const penaltyRate = (0, coa_rules_1.getPrematurePenaltyRate)(holdingMonths);
        // Calculate interest at reduced rate (original rate - penalty rate)
        const originalRate = Number(deposit.interestRate) / 100;
        const penalizedRate = Math.max(0, originalRate - (penaltyRate / 100));
        // Recalculate interest at penalized rate
        const principal = Number(deposit.principal);
        const actualInterest = Math.round(principal * penalizedRate * (holdingMonths / 12) * 100) / 100;
        const totalInterest = actualInterest;
        const { tdsAmount } = (0, coa_rules_1.computeTds)(totalInterest, deposit.isSeniorCitizen, !!deposit.member.panNumber, deposit.form15Exempt);
        const netPayable = principal + totalInterest - tdsAmount;
        await prisma_1.default.deposit.update({
            where: { id: deposit.id },
            data: { status: "prematurely_closed", closedAt: new Date(), tdsDeducted: tdsAmount },
        });
        // GL postings
        if (tdsAmount > 0) {
            await (0, gl_posting_1.postGl)(tenantId, "FDR_TDS_DEDUCTED", tdsAmount, `TDS on premature withdrawal — ${deposit.depositNumber}`, (0, gl_posting_1.currentPeriod)());
        }
        await (0, gl_posting_1.postGl)(tenantId, "FDR_MATURE", netPayable, `Premature withdrawal — ${deposit.depositNumber}`, (0, gl_posting_1.currentPeriod)());
        res.json({
            success: true,
            message: "Deposit closed (premature withdrawal)",
            principal: deposit.principal,
            holdingMonths,
            penaltyRate,
            penalizedRate: penalizedRate * 100,
            totalInterest,
            tdsDeducted: tdsAmount,
            netPayable: Math.round(netPayable * 100) / 100,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits/alerts/deaf — Deposits near DEAF trigger ──────────
router.get("/alerts/deaf", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const alertThreshold = new Date();
        alertThreshold.setFullYear(alertThreshold.getFullYear() - Math.floor(coa_rules_1.DEAF_TRIGGER_YEARS * 0.95)); // 9.5 years
        const unclaimedDeposits = await prisma_1.default.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                maturityDate: { lt: alertThreshold },
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } } },
        });
        res.json({ success: true, unclaimedDeposits, count: unclaimedDeposits.length });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/deposits/:id/interest-accrual — Accrue daily interest ─────
router.post("/:id/interest-accrual", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const deposit = await prisma_1.default.deposit.findFirst({ where: { id: req.params.id, tenantId } });
        if (!deposit || deposit.status !== "active") {
            res.status(404).json({ success: false, message: "Active deposit not found" });
            return;
        }
        const dailyRate = Number(deposit.interestRate) / 100 / 365;
        const dailyInterest = Math.round(Number(deposit.principal) * dailyRate * 100) / 100;
        await prisma_1.default.deposit.update({
            where: { id: deposit.id },
            data: { accruedInterest: Number(deposit.accruedInterest) + dailyInterest },
        });
        // GL: FDR interest accrual
        await (0, gl_posting_1.postGl)(tenantId, "FDR_INTEREST_ACCRUAL", dailyInterest, `Daily interest accrual — ${deposit.depositNumber}`, (0, gl_posting_1.currentPeriod)());
        res.json({ success: true, dailyInterest, totalAccrued: Number(deposit.accruedInterest) + dailyInterest });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits/:id/certificate — Generate FDR Certificate (DEP-009) ─────
router.get("/:id/certificate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const deposit = await prisma_1.default.deposit.findFirst({
            where: { id: req.params.id, tenantId, depositType: "fd" },
            include: {
                member: { select: { firstName: true, lastName: true, memberNumber: true, dateOfBirth: true } },
                tenant: { select: { name: true } },
            },
        });
        if (!deposit) {
            res.status(404).json({ success: false, message: "FDR deposit not found" });
            return;
        }
        // DEP-009: FDR Certificate Generation
        const memberName = `${deposit.member.firstName} ${deposit.member.lastName}`;
        const principal = Number(deposit.principal);
        const maturityAmount = deposit.maturityAmount ? Number(deposit.maturityAmount) : principal;
        const openedAt = deposit.openedAt;
        const maturityDate = deposit.maturityDate || new Date();
        // Generate HTML certificate (can be converted to PDF by frontend or using puppeteer)
        const certificateHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>FDR Certificate - ${deposit.depositNumber}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
        .header { text-align: center; border-bottom: 3px solid #000; padding-bottom: 20px; margin-bottom: 30px; }
        .society-name { font-size: 24px; font-weight: bold; margin-bottom: 5px; }
        .certificate-title { font-size: 20px; font-weight: bold; margin-top: 15px; }
        .certificate-no { font-family: monospace; font-size: 14px; color: #0066cc; margin-top: 10px; }
        .details { margin: 30px 0; }
        .detail-row { display: flex; justify-content: space-between; margin: 12px 0; padding: 8px 0; border-bottom: 1px dotted #ccc; }
        .detail-label { font-weight: bold; width: 40%; }
        .detail-value { width: 60%; text-align: right; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #000; font-size: 12px; text-align: center; color: #666; }
        .signature-section { margin-top: 50px; display: flex; justify-content: space-between; }
        .signature-box { width: 45%; text-align: center; }
        .signature-line { border-top: 1px solid #000; margin-top: 60px; padding-top: 5px; }
        @media print { body { margin: 20px; } .no-print { display: none; } }
    </style>
</head>
<body>
    <div class="header">
        <div class="society-name">${deposit.tenant.name || "Sahayog AI Cooperative Society"}</div>
        <div style="font-size: 12px; color: #666;">Registered under Maharashtra Co-operative Societies Act</div>
        <div class="certificate-title">FIXED DEPOSIT RECEIPT</div>
        <div class="certificate-no">Certificate No: ${deposit.depositNumber}</div>
    </div>

    <div class="details">
        <div class="detail-row">
            <span class="detail-label">Member Name:</span>
            <span class="detail-value">${memberName}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Member Number:</span>
            <span class="detail-value">${deposit.member.memberNumber}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Principal Amount:</span>
            <span class="detail-value">₹${principal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Rate of Interest:</span>
            <span class="detail-value">${Number(deposit.interestRate).toFixed(2)}% per annum${deposit.isSeniorCitizen ? ' (Senior Citizen)' : ''}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Compounding Frequency:</span>
            <span class="detail-value">${deposit.compoundingFreq.charAt(0).toUpperCase() + deposit.compoundingFreq.slice(1)}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Tenure:</span>
            <span class="detail-value">${deposit.tenureMonths} months</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Date of Opening:</span>
            <span class="detail-value">${openedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Date of Maturity:</span>
            <span class="detail-value">${maturityDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
        </div>
        <div class="detail-row" style="font-weight: bold; font-size: 16px; border-top: 2px solid #000; padding-top: 15px; margin-top: 20px;">
            <span class="detail-label">Maturity Amount:</span>
            <span class="detail-value">₹${maturityAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
    </div>

    <div class="signature-section">
        <div class="signature-box">
            <div class="signature-line">Authorized Signatory</div>
        </div>
        <div class="signature-box">
            <div class="signature-line">Secretary</div>
        </div>
    </div>

    <div class="footer">
        <p>This certificate is computer generated and does not require physical signature.</p>
        <p>Subject to terms and conditions of the society. This deposit is subject to premature withdrawal penalties as per policy.</p>
        <p>Generated on: ${new Date().toLocaleString('en-IN')}</p>
    </div>
</body>
</html>`;
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Content-Disposition", `inline; filename="FDR_Certificate_${deposit.depositNumber}.html"`);
        res.send(certificateHtml);
    }
    catch (err) {
        console.error("Certificate generation error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits/analytics — Deposit Portfolio Analytics (DEP-015) ─────
router.get("/analytics/portfolio", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { startDate, endDate } = req.query;
        const where = { tenantId };
        if (startDate || endDate) {
            where.openedAt = {};
            if (startDate)
                where.openedAt.gte = new Date(startDate);
            if (endDate)
                where.openedAt.lte = new Date(endDate);
        }
        const [deposits, totalCount] = await Promise.all([
            prisma_1.default.deposit.findMany({
                where,
                include: { member: { select: { firstName: true, lastName: true } } },
            }),
            prisma_1.default.deposit.count({ where }),
        ]);
        // Analytics calculations
        const totalPrincipal = deposits.reduce((sum, d) => sum + Number(d.principal), 0);
        const totalAccruedInterest = deposits.reduce((sum, d) => sum + Number(d.accruedInterest), 0);
        const totalMaturityAmount = deposits.reduce((sum, d) => sum + (Number(d.maturityAmount) || 0), 0);
        const byType = deposits.reduce((acc, d) => {
            acc[d.depositType] = (acc[d.depositType] || 0) + 1;
            return acc;
        }, {});
        const byStatus = deposits.reduce((acc, d) => {
            acc[d.status] = (acc[d.status] || 0) + 1;
            return acc;
        }, {});
        const activeDeposits = deposits.filter(d => d.status === "active");
        const maturingSoon = activeDeposits.filter(d => {
            if (!d.maturityDate)
                return false;
            const daysUntilMaturity = Math.floor((d.maturityDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
            return daysUntilMaturity >= 0 && daysUntilMaturity <= 30;
        });
        res.json({
            success: true,
            analytics: {
                summary: {
                    totalDeposits: totalCount,
                    totalPrincipal,
                    totalAccruedInterest,
                    totalMaturityAmount,
                    averagePrincipal: totalCount > 0 ? totalPrincipal / totalCount : 0,
                },
                byType,
                byStatus,
                maturingSoon: {
                    count: maturingSoon.length,
                    totalAmount: maturingSoon.reduce((sum, d) => sum + (Number(d.maturityAmount) || 0), 0),
                },
                activeDeposits: activeDeposits.length,
            },
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/deposits/form16a/:id — Generate Form 16A (DEP-013) ─────
router.get("/form16a/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const deposit = await prisma_1.default.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: { select: { firstName: true, lastName: true, panNumber: true, address: true } },
                tenant: { select: { name: true } },
            },
        });
        if (!deposit || !deposit.tdsDeducted || Number(deposit.tdsDeducted) === 0) {
            res.status(404).json({ success: false, message: "Deposit not found or no TDS deducted" });
            return;
        }
        // DEP-013: Form 16A Generation
        const form16aHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Form 16A - ${deposit.depositNumber}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
        .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 15px; margin-bottom: 20px; }
        .form-title { font-size: 18px; font-weight: bold; margin: 10px 0; }
        .section { margin: 20px 0; }
        .section-title { font-weight: bold; margin-bottom: 10px; border-bottom: 1px solid #ccc; padding-bottom: 5px; }
        .detail-row { display: flex; justify-content: space-between; margin: 8px 0; padding: 5px 0; }
        .detail-label { font-weight: bold; width: 40%; }
        .detail-value { width: 60%; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 2px solid #000; font-size: 12px; text-align: center; }
        @media print { body { margin: 20px; } }
    </style>
</head>
<body>
    <div class="header">
        <div class="form-title">FORM 16A</div>
        <div style="font-size: 14px;">Certificate under Section 203 of the Income-tax Act, 1961</div>
        <div style="font-size: 12px; margin-top: 5px;">for tax deducted at source</div>
    </div>

    <div class="section">
        <div class="section-title">PART A - Details of the Deductor</div>
        <div class="detail-row">
            <span class="detail-label">Name:</span>
            <span class="detail-value">${deposit.tenant.name || "Sahayog AI Cooperative Society"}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">TAN:</span>
            <span class="detail-value">[TAN Number]</span>
        </div>
    </div>

    <div class="section">
        <div class="section-title">PART B - Details of the Deductee</div>
        <div class="detail-row">
            <span class="detail-label">Name:</span>
            <span class="detail-value">${deposit.member.firstName} ${deposit.member.lastName}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">PAN:</span>
            <span class="detail-value">${deposit.member.panNumber || "Not Provided"}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Address:</span>
            <span class="detail-value">${deposit.member.address || "N/A"}</span>
        </div>
    </div>

    <div class="section">
        <div class="section-title">PART C - Details of Tax Deducted at Source</div>
        <div class="detail-row">
            <span class="detail-label">Assessment Year:</span>
            <span class="detail-value">${new Date().getFullYear() + 1}-${new Date().getFullYear() + 2}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Deposit Number:</span>
            <span class="detail-value">${deposit.depositNumber}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Section Code:</span>
            <span class="detail-value">194A</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Interest Amount:</span>
            <span class="detail-value">₹${Number(deposit.accruedInterest).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">TDS Amount:</span>
            <span class="detail-value">₹${Number(deposit.tdsDeducted).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Date of Deduction:</span>
            <span class="detail-value">${deposit.closedAt ? new Date(deposit.closedAt).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN')}</span>
        </div>
    </div>

    <div class="footer">
        <p>This is a computer generated certificate and does not require signature.</p>
        <p>Generated on: ${new Date().toLocaleString('en-IN')}</p>
    </div>
</body>
</html>`;
        res.setHeader("Content-Type", "text/html");
        res.setHeader("Content-Disposition", `inline; filename="Form16A_${deposit.depositNumber}.html"`);
        res.send(form16aHtml);
    }
    catch (err) {
        console.error("Form 16A generation error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=deposits.js.map