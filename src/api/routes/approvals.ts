/**
 * Approvals Queue — Aggregate pending vouchers, loan applications for checker workflow
 */
import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// Map to ApprovalItem-like shape
type ApprovalSource = "voucher" | "loan_application";

// GET /api/v1/approvals — aggregated pending/approved/rejected items
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status } = req.query as Record<string, string>; // pending | approved | rejected | all

        const items: {
            id: string;
            source: ApprovalSource;
            type: string;
            status: string;
            description: string;
            makerName: string;
            makerRole: string;
            amount?: number;
            createdAt: string;
            slaDeadline: string;
            entityId: string;
            entityType: string;
        }[] = [];

        // Vouchers (Journal Entries - maker-checker)
        const vStatus = status === "approved" ? "approved" : status === "rejected" ? "rejected" : status === "all" ? undefined : "pending";
        const vouchers = await prisma.voucher.findMany({
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
        const appWhere: Record<string, unknown> = { tenantId };
        if (appStatus) appWhere.status = appStatus;
        const applications = await prisma.loanApplication.findMany({
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
    } catch (err) {
        console.error("[Approvals GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/approvals/voucher/:id/approve
router.post("/voucher/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { comments } = (req.body || {}) as { comments?: string };
        const voucher = await prisma.voucher.update({
            where: { id: req.params.id },
            data: {
                status: "approved",
                checkerUserId: req.user?.userId,
                approvedAt: new Date(),
                narration: comments ? `${req.user?.userId}: ${comments}` : undefined,
            },
        });
        res.json({ success: true, voucher });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/approvals/voucher/:id/reject
router.post("/voucher/:id/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { reason } = (req.body || {}) as { reason?: string };
        const voucher = await prisma.voucher.update({
            where: { id: req.params.id },
            data: { status: "rejected" },
        });
        res.json({ success: true, voucher });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/approvals/loan/:id/approve
router.post("/loan/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { comments } = (req.body || {}) as { comments?: string };
        const app = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: {
                status: "approved",
                reviewedAt: new Date(),
                reviewedBy: req.user?.userId,
                remarks: comments,
            },
        });
        res.json({ success: true, application: app });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/approvals/loan/:id/reject
router.post("/loan/:id/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { reason } = (req.body || {}) as { reason?: string };
        const app = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: {
                status: "rejected",
                reviewedAt: new Date(),
                reviewedBy: req.user?.userId,
                remarks: reason || "Rejected",
            },
        });
        res.json({ success: true, application: app });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
