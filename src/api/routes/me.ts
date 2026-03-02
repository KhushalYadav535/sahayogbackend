import { Router, Response } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import prisma from "../../db/prisma";
import { memberAuthMiddleware, MemberAuthRequest } from "../middleware/member-auth";
import { canSendSms, recordSmsSent } from "../../services/sms.service";

const router = Router();
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// GET /api/v1/me/tenant?code=XXX — resolve society code to tenantId (public, for member portal)
router.get("/tenant", async (req: any, res: Response): Promise<void> => {
    try {
        const code = (req.query.code as string)?.trim();
        if (!code) {
            res.status(400).json({ success: false, message: "Code required" });
            return;
        }
        const tenant = await prisma.tenant.findUnique({
            where: { code },
            select: { id: true, name: true, code: true },
        });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Society not found" });
            return;
        }
        res.json({ success: true, tenant: { id: tenant.id, name: tenant.name, code: tenant.code } });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/me/request-otp — send OTP via SMS (integrated with recordSmsSent)
router.post("/request-otp", async (req: any, res: Response): Promise<void> => {
    try {
        const { phone, tenantId } = z.object({ phone: z.string().min(10), tenantId: z.string() }).parse(req.body);
        const member = await prisma.member.findFirst({ where: { phone, tenantId, status: "active" } });
        if (!member) {
            res.status(401).json({ success: false, message: "Member not found" });
            return;
        }

        const allowed = await canSendSms(tenantId);
        if (!allowed) {
            res.status(402).json({ success: false, message: "SMS credits exhausted. Please contact your society." });
            return;
        }

        const code = String(Math.floor(100000 + Math.random() * 900000));
        await prisma.otpCode.upsert({
            where: { tenantId_phone: { tenantId, phone } },
            update: { code, expiresAt: new Date(Date.now() + OTP_EXPIRY_MS) },
            create: { tenantId, phone, code, expiresAt: new Date(Date.now() + OTP_EXPIRY_MS) },
        });

        // In production: call SMS gateway (Twilio, MSG91, etc.) with code
        // For now: simulate send and record usage
        if (process.env.SMS_GATEWAY_URL) {
            // TODO: fetch(SMS_GATEWAY_URL, { method: 'POST', body: JSON.stringify({ to: phone, body: `Your OTP is ${code}` }) })
        }
        await recordSmsSent(tenantId);

        res.json({ success: true, message: "OTP sent" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/me/verify-otp — verify OTP and return token
router.post("/verify-otp", async (req: any, res: Response): Promise<void> => {
    try {
        const { phone, tenantId, otp } = z.object({ phone: z.string(), tenantId: z.string(), otp: z.string().length(6) }).parse(req.body);
        const otpRow = await prisma.otpCode.findUnique({
            where: { tenantId_phone: { tenantId, phone } },
        });
        if (!otpRow || otpRow.code !== otp || otpRow.expiresAt < new Date()) {
            res.status(401).json({ success: false, message: "Invalid or expired OTP" });
            return;
        }

        await prisma.otpCode.delete({ where: { tenantId_phone: { tenantId, phone } } });

        const member = await prisma.member.findFirst({ where: { phone, tenantId, status: "active" } });
        if (!member) {
            res.status(401).json({ success: false, message: "Member not found" });
            return;
        }

        const token = jwt.sign(
            { memberId: member.id, tenantId: member.tenantId, phone: member.phone },
            process.env.MEMBER_JWT_SECRET || "fallback_member_secret",
            { expiresIn: "24h" }
        );

        res.json({
            success: true,
            token,
            member: { id: member.id, firstName: member.firstName, lastName: member.lastName, memberNumber: member.memberNumber },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/me/login — legacy: direct token (dev only). Prefer request-otp + verify-otp.
router.post("/login", async (req: any, res: Response): Promise<void> => {
    try {
        const { phone, tenantId } = z.object({ phone: z.string(), tenantId: z.string() }).parse(req.body);
        const member = await prisma.member.findFirst({ where: { phone, tenantId, status: "active" } });
        if (!member) {
            res.status(401).json({ success: false, message: "Member not found" });
            return;
        }

        const token = jwt.sign(
            { memberId: member.id, tenantId: member.tenantId, phone: member.phone },
            process.env.MEMBER_JWT_SECRET || "fallback_member_secret",
            { expiresIn: "24h" }
        );

        res.json({
            success: true,
            token,
            member: { id: member.id, firstName: member.firstName, lastName: member.lastName, memberNumber: member.memberNumber },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/me/accounts
router.get("/accounts", memberAuthMiddleware, async (req: MemberAuthRequest, res: Response): Promise<void> => {
    try {
        const accounts = await prisma.sbAccount.findMany({
            where: { memberId: req.member!.memberId, status: "active" },
            select: { id: true, accountNumber: true, accountType: true, balance: true, openedAt: true },
        });
        res.json({ success: true, accounts });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/me/accounts/:id/passbook
router.get("/accounts/:id/passbook", memberAuthMiddleware, async (req: MemberAuthRequest, res: Response): Promise<void> => {
    try {
        const account = await prisma.sbAccount.findFirst({
            where: { id: req.params.id, memberId: req.member!.memberId },
        });
        if (!account) {
            res.status(404).json({ success: false, message: "Account not found" });
            return;
        }

        const { page = "1", limit = "30" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [transactions, total] = await Promise.all([
            prisma.transaction.findMany({
                where: { accountId: req.params.id },
                orderBy: { processedAt: "desc" },
                skip,
                take: parseInt(limit),
            }),
            prisma.transaction.count({ where: { accountId: req.params.id } }),
        ]);

        res.json({ success: true, account, transactions, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/me/loans
router.get("/loans", memberAuthMiddleware, async (req: MemberAuthRequest, res: Response): Promise<void> => {
    try {
        const loans = await prisma.loan.findMany({
            where: { memberId: req.member!.memberId },
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/me/loans/:id/schedule
router.get("/loans/:id/schedule", memberAuthMiddleware, async (req: MemberAuthRequest, res: Response): Promise<void> => {
    try {
        const loan = await prisma.loan.findFirst({
            where: { id: req.params.id, memberId: req.member!.memberId },
            include: { emiSchedule: { orderBy: { installmentNo: "asc" } } },
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

// POST /api/v1/me/loans/:id/pay  (UPI payment stub)
router.post("/loans/:id/pay", memberAuthMiddleware, async (req: MemberAuthRequest, res: Response): Promise<void> => {
    try {
        const { amount, upiId, emiId } = z.object({
            amount: z.number().positive(),
            upiId: z.string().optional(),
            emiId: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({
            where: { id: req.params.id, memberId: req.member!.memberId },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        // Stub: in production, call UPI gateway here
        const paymentRef = `UPI${Date.now()}`;

        if (emiId) {
            const emi = await prisma.emiSchedule.findUnique({ where: { id: emiId } });
            if (emi) {
                const paidAmount = Number(emi.paidAmount) + amount;
                const status = paidAmount >= Number(emi.totalEmi) ? "paid" : "partial";
                await prisma.emiSchedule.update({
                    where: { id: emiId },
                    data: { paidAmount, paidAt: status === "paid" ? new Date() : undefined, status },
                });
            }
        }

        res.json({ success: true, paymentRef, message: "Payment recorded successfully" });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
