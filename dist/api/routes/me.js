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
            res.status(400).json({ success: false, errors: err.issues });
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
            res.status(400).json({ success: false, errors: err.issues });
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
// POST /api/v1/me/login-dob — Mobile + Date of Birth login (no society code / tenantId required)
// Searches across ALL tenants by phone, then verifies DOB
router.post("/login-dob", async (req, res) => {
    try {
        const { phone: rawPhone, dateOfBirth } = zod_1.z.object({
            phone: zod_1.z.string().min(10),
            dateOfBirth: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
        }).parse(req.body);
        // Normalize phone — strip +91, leading 0, spaces, dashes
        const normalized = rawPhone.replace(/\D/g, "").replace(/^91(\d{10})$/, "$1").replace(/^0(\d{10})$/, "$1");
        // Search for matching phone in multiple formats (any status first)
        const members = await prisma_1.default.member.findMany({
            where: {
                OR: [
                    { phone: normalized },
                    { phone: `+91${normalized}` },
                    { phone: `0${normalized}` },
                    { phone: rawPhone },
                ],
            },
        });
        // Dev log — remove when going to production
        console.log(`[login-dob] phone="${rawPhone}" normalized="${normalized}" found=${members.length}`, members.map((m) => ({ id: m.id, phone: m.phone, status: m.status, hasDob: !!m.dateOfBirth })));
        if (members.length === 0) {
            res.status(401).json({ success: false, message: "Mobile number not registered. Please check the number registered with your society." });
            return;
        }
        // Check activity status
        const activeMembers = members.filter((m) => m.status === "active");
        if (activeMembers.length === 0) {
            res.status(401).json({ success: false, message: `Account is ${members[0].status}. Please contact your society manager.` });
            return;
        }
        // Verify DOB against active members
        const inputDob = new Date(dateOfBirth);
        const member = activeMembers.find((m) => {
            if (!m.dateOfBirth)
                return false;
            const storedDob = new Date(m.dateOfBirth);
            return (storedDob.getFullYear() === inputDob.getFullYear() &&
                storedDob.getMonth() === inputDob.getMonth() &&
                storedDob.getDate() === inputDob.getDate());
        });
        if (!member) {
            // If active member has no DOB on record at all
            const noDob = activeMembers.find((m) => !m.dateOfBirth);
            if (noDob) {
                res.status(401).json({ success: false, message: "Date of birth not on record. Please contact your society to update it." });
            }
            else {
                res.status(401).json({ success: false, message: "Date of birth does not match our records. Please check and try again." });
            }
            return;
        }
        const token = jsonwebtoken_1.default.sign({ memberId: member.id, tenantId: member.tenantId, phone: member.phone }, process.env.MEMBER_JWT_SECRET || "fallback_member_secret", { expiresIn: "24h" });
        res.json({
            success: true,
            token,
            member: {
                id: member.id,
                firstName: member.firstName,
                lastName: member.lastName,
                memberNumber: member.memberNumber,
            },
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[login-dob] error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/me/summary - Dashboard stats for member portal
router.get("/summary", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const memberId = req.member.memberId;
        // 1. SB Balance
        const sbAccounts = await prisma_1.default.sbAccount.findMany({ where: { memberId, status: "active" } });
        const sbBalance = sbAccounts.reduce((sum, acc) => sum + Number(acc.balance), 0);
        // 2. Loans
        const loans = await prisma_1.default.loan.findMany({ where: { memberId, status: "ACTIVE" } });
        const activeLoansCount = loans.length;
        const totalLoanOutstanding = loans.reduce((sum, loan) => sum + Number(loan.outstandingPrincipal), 0);
        // 3. Deposits (FDR/RD)
        const depositsList = await prisma_1.default.deposit.findMany({ where: { memberId, status: "active" } });
        const depositsCount = depositsList.length;
        const totalDepositAmount = depositsList.reduce((sum, dep) => sum + Number(dep.amount), 0);
        // 4. Next upcoming EMI
        const upcomingEmis = await prisma_1.default.emiSchedule.findMany({
            where: { loan: { memberId }, status: "pending", dueDate: { gte: new Date() } },
            orderBy: { dueDate: "asc" },
            take: 1
        });
        const upcomingEMI = upcomingEmis.length > 0 ? Number(upcomingEmis[0].totalEmi) : 0;
        const emiDueDate = upcomingEmis.length > 0 ? upcomingEmis[0].dueDate : null;
        // 5. Recent transactions (last 5)
        const accountIds = sbAccounts.map(a => a.id);
        const recentTxns = await prisma_1.default.transaction.findMany({
            where: { accountId: { in: accountIds } },
            orderBy: { processedAt: "desc" },
            take: 5
        });
        res.json({
            success: true,
            summary: {
                sbBalance,
                activeLoansCount,
                totalLoanOutstanding,
                depositsCount,
                totalDepositAmount,
                upcomingEMI,
                emiDueDate,
                recentTxns: recentTxns.map(t => ({
                    id: t.id,
                    date: t.processedAt,
                    desc: t.remarks || t.category || "Transaction",
                    amount: Number(t.amount),
                    type: t.type === "credit" ? "credit" : "debit"
                }))
            }
        });
    }
    catch (err) {
        console.error("[me/summary] error:", err);
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
// GET /api/v1/me/deposits
router.get("/deposits", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const deposits = await prisma_1.default.deposit.findMany({
            where: { memberId: req.member.memberId },
            select: {
                id: true,
                depositNumber: true,
                depositType: true,
                amount: true,
                maturityAmount: true,
                maturityDate: true,
                status: true,
                interestRate: true,
                openedAt: true,
                tenureMonths: true,
            },
        });
        res.json({ success: true, deposits });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MP-004: GET /api/v1/me/deposits/maturity-tracker - FDR Maturity Tracker
router.get("/deposits/maturity-tracker", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const { days = "30" } = req.query;
        const daysAhead = parseInt(days) || 30;
        const today = new Date();
        const futureDate = new Date(today);
        futureDate.setDate(futureDate.getDate() + daysAhead);
        const deposits = await prisma_1.default.deposit.findMany({
            where: {
                memberId: req.member.memberId,
                status: "active",
                maturityDate: {
                    gte: today,
                    lte: futureDate,
                },
            },
            select: {
                id: true,
                depositNumber: true,
                depositType: true,
                amount: true,
                maturityAmount: true,
                maturityDate: true,
                interestRate: true,
                openedAt: true,
            },
            orderBy: { maturityDate: "asc" },
        });
        const depositsWithDays = deposits.map(dep => {
            const maturityDate = new Date(dep.maturityDate);
            const daysUntilMaturity = Math.ceil((maturityDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            return {
                ...dep,
                daysUntilMaturity,
                isOverdue: daysUntilMaturity < 0,
            };
        });
        res.json({ success: true, deposits: depositsWithDays, total: depositsWithDays.length });
    }
    catch (err) {
        console.error("[me/deposits/maturity-tracker] error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MP-009: GET /api/v1/me/shares/certificate - Share Certificate View
router.get("/shares/certificate", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const memberId = req.member.memberId;
        const member = await prisma_1.default.member.findUnique({
            where: { id: memberId },
            select: {
                id: true,
                memberNumber: true,
                firstName: true,
                lastName: true,
                dateOfBirth: true,
                address: true,
                phone: true,
            },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        const shareLedger = await prisma_1.default.shareLedger.findMany({
            where: { memberId },
            orderBy: { date: "asc" },
        });
        const totalShares = shareLedger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
        }, 0);
        const totalShareValue = shareLedger.reduce((sum, tx) => {
            return tx.transactionType === "purchase" ? sum + Number(tx.amount) : sum - Number(tx.amount);
        }, 0);
        res.json({
            success: true,
            member,
            totalShares,
            totalShareValue,
            shareLedger: shareLedger.map(tx => ({
                id: tx.id,
                date: tx.date,
                transactionType: tx.transactionType,
                shares: tx.shares,
                faceValue: Number(tx.faceValue),
                amount: Number(tx.amount),
                remarks: tx.remarks,
            })),
        });
    }
    catch (err) {
        console.error("[me/shares/certificate] error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MP-008: POST /api/v1/me/grievance - Grievance Submission
router.post("/grievance", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const { category, subject, description, priority } = zod_1.z.object({
            category: zod_1.z.string().min(1),
            subject: zod_1.z.string().min(1),
            description: zod_1.z.string().min(10),
            priority: zod_1.z.enum(["low", "medium", "high"]).optional().default("medium"),
        }).parse(req.body);
        const memberId = req.member.memberId;
        const tenantId = req.member.tenantId;
        // Create grievance record (using a simple approach - could be enhanced with a Grievance model)
        const grievanceRef = `GRV-${Date.now()}-${memberId.slice(-6).toUpperCase()}`;
        // For now, log it in audit log. In production, create a Grievance model
        await prisma_1.default.auditLog.create({
            data: {
                tenantId,
                userId: memberId,
                action: "GRIEVANCE_SUBMITTED",
                entity: "Grievance",
                entityId: grievanceRef,
                newData: {
                    category,
                    subject,
                    description,
                    priority,
                    memberId,
                    submittedAt: new Date().toISOString(),
                },
            },
        });
        res.json({
            success: true,
            grievanceRef,
            message: "Grievance submitted successfully. Reference: " + grievanceRef,
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[me/grievance] error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MP-007: GET /api/v1/me/notifications/preferences - Get Notification Preferences
router.get("/notifications/preferences", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const memberId = req.member.memberId;
        // For now, return default preferences. In production, store in Member model or separate table
        res.json({
            success: true,
            preferences: {
                sms: {
                    emiReminders: true,
                    depositMaturity: true,
                    transactionAlerts: true,
                    generalUpdates: false,
                },
                email: {
                    emiReminders: true,
                    depositMaturity: true,
                    transactionAlerts: false,
                    generalUpdates: true,
                },
                push: {
                    emiReminders: true,
                    depositMaturity: true,
                    transactionAlerts: true,
                    generalUpdates: true,
                },
            },
        });
    }
    catch (err) {
        console.error("[me/notifications/preferences] error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// MP-007: PUT /api/v1/me/notifications/preferences - Update Notification Preferences
router.put("/notifications/preferences", member_auth_1.memberAuthMiddleware, async (req, res) => {
    try {
        const preferences = zod_1.z.object({
            sms: zod_1.z.object({
                emiReminders: zod_1.z.boolean(),
                depositMaturity: zod_1.z.boolean(),
                transactionAlerts: zod_1.z.boolean(),
                generalUpdates: zod_1.z.boolean(),
            }),
            email: zod_1.z.object({
                emiReminders: zod_1.z.boolean(),
                depositMaturity: zod_1.z.boolean(),
                transactionAlerts: zod_1.z.boolean(),
                generalUpdates: zod_1.z.boolean(),
            }),
            push: zod_1.z.object({
                emiReminders: zod_1.z.boolean(),
                depositMaturity: zod_1.z.boolean(),
                transactionAlerts: zod_1.z.boolean(),
                generalUpdates: zod_1.z.boolean(),
            }),
        }).parse(req.body);
        const memberId = req.member.memberId;
        const tenantId = req.member.tenantId;
        // Store preferences in audit log for now. In production, update Member model or separate table
        await prisma_1.default.auditLog.create({
            data: {
                tenantId,
                userId: memberId,
                action: "NOTIFICATION_PREFERENCES_UPDATED",
                entity: "Member",
                entityId: memberId,
                newData: preferences,
            },
        });
        res.json({ success: true, preferences, message: "Notification preferences updated successfully" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[me/notifications/preferences] error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=me.js.map