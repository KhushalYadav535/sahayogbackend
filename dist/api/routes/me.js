"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = __importDefault(require("../../db/prisma"));
const member_auth_1 = require("../middleware/member-auth");
const sms_service_1 = require("../../services/sms.service");
const router = (0, express_1.Router)();
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
// GET /api/v1/me/tenant?code=XXX — resolve society code to tenantId (public, for member portal)
router.get("/tenant", async (req, res) => {
    try {
        const code = req.query.code?.trim();
        if (!code) {
            res.status(400).json({ success: false, message: "Code required" });
            return;
        }
        const tenant = await prisma_1.default.tenant.findUnique({
            where: { code },
            select: { id: true, name: true, code: true },
        });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Society not found" });
            return;
        }
        res.json({ success: true, tenant: { id: tenant.id, name: tenant.name, code: tenant.code } });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/me/request-otp — send OTP via SMS (integrated with recordSmsSent)
router.post("/request-otp", async (req, res) => {
    try {
        const { phone, tenantId } = zod_1.z.object({ phone: zod_1.z.string().min(10), tenantId: zod_1.z.string() }).parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { phone, tenantId, status: "active" } });
        if (!member) {
            res.status(401).json({ success: false, message: "Member not found" });
            return;
        }
        const allowed = await (0, sms_service_1.canSendSms)(tenantId);
        if (!allowed) {
            res.status(402).json({ success: false, message: "SMS credits exhausted. Please contact your society." });
            return;
        }
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await prisma_1.default.otpCode.upsert({
            where: { tenantId_phone: { tenantId, phone } },
            update: { code, expiresAt: new Date(Date.now() + OTP_EXPIRY_MS) },
            create: { tenantId, phone, code, expiresAt: new Date(Date.now() + OTP_EXPIRY_MS) },
        });
        // In production: call SMS gateway (Twilio, MSG91, etc.) with code
        // For now: simulate send and record usage
        if (process.env.SMS_GATEWAY_URL) {
            // TODO: fetch(SMS_GATEWAY_URL, { method: 'POST', body: JSON.stringify({ to: phone, body: `Your OTP is ${code}` }) })
        }
        await (0, sms_service_1.recordSmsSent)(tenantId);
        res.json({ success: true, message: "OTP sent" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/me/verify-otp — verify OTP and return token
router.post("/verify-otp", async (req, res) => {
    try {
        const { phone, tenantId, otp } = zod_1.z.object({ phone: zod_1.z.string(), tenantId: zod_1.z.string(), otp: zod_1.z.string().length(6) }).parse(req.body);
        const otpRow = await prisma_1.default.otpCode.findUnique({
            where: { tenantId_phone: { tenantId, phone } },
        });
        if (!otpRow || otpRow.code !== otp || otpRow.expiresAt < new Date()) {
            res.status(401).json({ success: false, message: "Invalid or expired OTP" });
            return;
        }
        await prisma_1.default.otpCode.delete({ where: { tenantId_phone: { tenantId, phone } } });
        const member = await prisma_1.default.member.findFirst({ where: { phone, tenantId, status: "active" } });
        if (!member) {
            res.status(401).json({ success: false, message: "Member not found" });
            return;
        }
        const token = jsonwebtoken_1.default.sign({ memberId: member.id, tenantId: member.tenantId, phone: member.phone }, process.env.MEMBER_JWT_SECRET || "fallback_member_secret", { expiresIn: "24h" });
        res.json({
            success: true,
            token,
            member: { id: member.id, firstName: member.firstName, lastName: member.lastName, memberNumber: member.memberNumber },
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
// POST /api/v1/me/login — legacy: direct token (dev only). Prefer request-otp + verify-otp.
router.post("/login", async (req, res) => {
    try {
        const { phone, tenantId } = zod_1.z.object({ phone: zod_1.z.string(), tenantId: zod_1.z.string() }).parse(req.body);
        const member = await prisma_1.default.member.findFirst({ where: { phone, tenantId, status: "active" } });
        if (!member) {
            res.status(401).json({ success: false, message: "Member not found" });
            return;
        }
        const token = jsonwebtoken_1.default.sign({ memberId: member.id, tenantId: member.tenantId, phone: member.phone }, process.env.MEMBER_JWT_SECRET || "fallback_member_secret", { expiresIn: "24h" });
        res.json({
            success: true,
            token,
            member: { id: member.id, firstName: member.firstName, lastName: member.lastName, memberNumber: member.memberNumber },
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/me/accounts
router.get("/accounts", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const accounts = await prisma_1.default.sbAccount.findMany({
            where: { memberId: req.member.memberId, status: "active" },
            select: { id: true, accountNumber: true, accountType: true, balance: true, openedAt: true },
        });
        res.json({ success: true, accounts });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/me/accounts/:id/passbook
router.get("/accounts/:id/passbook", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const account = await prisma_1.default.sbAccount.findFirst({
            where: { id: req.params.id, memberId: req.member.memberId },
        });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }
        const { page = "1", limit = "30" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [transactions, total] = await Promise.all([
            prisma_1.default.transaction.findMany({
                where: { accountId: req.params.id },
                orderBy: { processedAt: "desc" },
                skip,
                take: parseInt(limit),
            }),
            prisma_1.default.transaction.count({ where: { accountId: req.params.id } }),
        ]);
        res.json({ success: true, account, transactions, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/me/loans
router.get("/loans", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const loans = await prisma_1.default.loan.findMany({
            where: { memberId: req.member.memberId },
            select: {
                id: true,
                loanNumber: true,
                loanType: true,
                principalAmount: true,
                disbursedAmount: true,
                outstandingPrincipal: true,
                status: true,
                disbursedAt: true,
            },
        });
        res.json({ success: true, loans });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/me/loans/:id/schedule
router.get("/loans/:id/schedule", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.id, memberId: req.member.memberId },
            include: { emiSchedule: { orderBy: { installmentNo: "asc" } } },
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
// POST /api/v1/me/loans/:id/pay  (UPI payment stub)
router.post("/loans/:id/pay", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const { amount, upiId, emiId } = zod_1.z.object({
            amount: zod_1.z.number().positive(),
            upiId: zod_1.z.string().optional(),
            emiId: zod_1.z.string().optional(),
        }).parse(req.body);
        const loan = await prisma_1.default.loan.findFirst({
            where: { id: req.params.id, memberId: req.member.memberId },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        // Stub: in production, call UPI gateway here
        const paymentRef = `UPI${Date.now()}`;
        if (emiId) {
            const emi = await prisma_1.default.emiSchedule.findUnique({ where: { id: emiId } });
            if (emi) {
                const paidAmount = Number(emi.paidAmount) + amount;
                const status = paidAmount >= Number(emi.totalEmi) ? "paid" : "partial";
                await prisma_1.default.emiSchedule.update({
                    where: { id: emiId },
                    data: { paidAmount, paidAt: status === "paid" ? new Date() : undefined, status },
                });
            }
        }
        res.json({ success: true, paymentRef, message: "Payment recorded successfully" });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=me.js.map