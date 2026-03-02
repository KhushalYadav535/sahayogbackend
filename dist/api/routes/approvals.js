"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Approvals Queue — Aggregate pending vouchers, loan applications for checker workflow
 */
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// GET /api/v1/approvals — aggregated pending/approved/rejected items
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status } = req.query; // pending | approved | rejected | all
        const items = [];
        // Vouchers (Journal Entries - maker-checker)
        const vStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : status === "all" ? undefined : "pending";
        const vouchers = await prisma_1.default.voucher.findMany({
            where: vStatus ? { tenantId, status: vStatus } : { tenantId },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        for (const v of vouchers) {
            const sla = new Date(v.createdAt);
            sla.setHours(sla.getHours() + 24);
            items.push({
                id: v.id,
                source: "voucher",
                type: "JOURNAL_ENTRY",
                status: v.status === "pending" ? "PENDING_APPROVAL" : v.status.toUpperCase(),
                description: v.narration || `Journal ${v.voucherNumber} — ₹${Number(v.totalAmount).toLocaleString("en-IN")}`,
                makerName: v.makerUserId ? `User ${v.makerUserId.slice(-6)}` : "System",
                makerRole: "Accountant",
                amount: Number(v.totalAmount),
                createdAt: v.createdAt.toISOString(),
                slaDeadline: sla.toISOString(),
                entityId: v.voucherNumber,
                entityType: "JournalEntry",
            });
        }
        // Loan applications (pending/approved/rejected)
        const appStatus = status === "pending" ? "pending" : status === "approved" ? "approved" : status === "rejected" ? "rejected" : undefined;
        const appWhere = { tenantId };
        if (appStatus)
            appWhere.status = appStatus;
        const applications = await prisma_1.default.loanApplication.findMany({
            where: appWhere,
            orderBy: { appliedAt: "desc" },
            take: 100,
            include: { member: { select: { firstName: true, lastName: true } } },
        });
        for (const a of applications) {
            const sla = new Date(a.appliedAt);
            sla.setDate(sla.getDate() + 3);
            items.push({
                id: a.id,
                source: "loan_application",
                type: "LOAN_APPROVAL",
                status: a.status === "pending" ? "PENDING_APPROVAL" : a.status.toUpperCase(),
                description: `Loan application for ₹${Number(a.amountRequested).toLocaleString("en-IN")} — ${a.member.firstName} ${a.member.lastName}`,
                makerName: a.reviewedBy ? `User ${a.reviewedBy.slice(-6)}` : "Applicant",
                makerRole: "Loan Officer",
                amount: Number(a.amountRequested),
                createdAt: a.appliedAt.toISOString(),
                slaDeadline: sla.toISOString(),
                entityId: a.id,
                entityType: "Loan",
            });
        }
        items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const pending = items.filter((i) => i.status === "PENDING_APPROVAL");
        const approved = items.filter((i) => i.status === "APPROVED");
        const rejected = items.filter((i) => i.status === "REJECTED");
        res.json({
            success: true,
            approvals: status ? items : pending,
            pending,
            approved,
            rejected,
            escalated: [],
        });
    }
    catch (err) {
        console.error("[Approvals GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/approvals/voucher/:id/approve
router.post("/voucher/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { comments } = (req.body || {});
        const voucher = await prisma_1.default.voucher.update({
            where: { id: req.params.id },
            data: {
                status: "approved",
                checkerUserId: req.user?.userId,
                approvedAt: new Date(),
                narration: comments ? `${req.user?.userId}: ${comments}` : undefined,
            },
        });
        res.json({ success: true, voucher });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/approvals/voucher/:id/reject
router.post("/voucher/:id/reject", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { reason } = (req.body || {});
        const voucher = await prisma_1.default.voucher.update({
            where: { id: req.params.id },
            data: { status: "rejected" },
        });
        res.json({ success: true, voucher });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/approvals/loan/:id/approve
router.post("/loan/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { comments } = (req.body || {});
        const app = await prisma_1.default.loanApplication.update({
            where: { id: req.params.id },
            data: {
                status: "approved",
                reviewedAt: new Date(),
                reviewedBy: req.user?.userId,
                remarks: comments,
            },
        });
        res.json({ success: true, application: app });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/approvals/loan/:id/reject
router.post("/loan/:id/reject", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { reason } = (req.body || {});
        const app = await prisma_1.default.loanApplication.update({
            where: { id: req.params.id },
            data: {
                status: "rejected",
                reviewedAt: new Date(),
                reviewedBy: req.user?.userId,
                remarks: reason || "Rejected",
            },
        });
        res.json({ success: true, application: app });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=approvals.js.map