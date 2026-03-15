/**
 * Approvals Queue — Aggregate pending vouchers, loan applications for checker workflow
 */
import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// Map to ApprovalItem-like shape
type ApprovalSource = "voucher" | "loan_application" | "loan_product" | "interest_scheme";

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

        // BRD v5.0 LN-A01: Loan Products pending approval
        const loanProducts = await prisma.loanProduct.findMany({
            where: { tenantId, status: "PENDING_APPROVAL" },
            orderBy: { submittedAt: "desc" },
            take: 100,
            include: {
                interestScheme: { select: { schemeCode: true, schemeName: true } },
            },
        });
        for (const p of loanProducts) {
            const sla = p.submittedAt ? new Date(p.submittedAt) : new Date(p.createdAt);
            sla.setHours(sla.getHours() + 24);
            const ageHours = Math.floor((Date.now() - sla.getTime()) / (1000 * 60 * 60));
            items.push({
                id: p.id,
                source: "loan_product",
                type: "LOAN_PRODUCT",
                status: "PENDING_APPROVAL",
                description: `Loan Product: ${p.productName} (${p.category})`,
                makerName: p.makerId ? `User ${p.makerId.slice(-6)}` : "System",
                makerRole: "Society Admin",
                createdAt: p.submittedAt?.toISOString() || p.createdAt.toISOString(),
                slaDeadline: sla.toISOString(),
                entityId: p.productCode,
                entityType: "LoanProduct",
            });
        }

        // BRD v5.0 LN-A01: Interest Schemes pending approval
        const interestSchemes = await prisma.interestScheme.findMany({
            where: { tenantId, status: "PENDING_APPROVAL" },
            orderBy: { submittedAt: "desc" },
            take: 100,
        });
        for (const s of interestSchemes) {
            const sla = s.submittedAt ? new Date(s.submittedAt) : new Date(s.createdAt);
            sla.setHours(sla.getHours() + 24);
            items.push({
                id: s.id,
                source: "interest_scheme",
                type: "INTEREST_SCHEME",
                status: "PENDING_APPROVAL",
                description: `Interest Scheme: ${s.schemeName} (${s.schemeCode})`,
                makerName: s.makerId ? `User ${s.makerId.slice(-6)}` : "System",
                makerRole: "Accountant",
                createdAt: s.submittedAt?.toISOString() || s.createdAt.toISOString(),
                slaDeadline: sla.toISOString(),
                entityId: s.schemeCode,
                entityType: "InterestScheme",
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

// BRD v5.0 LN-A02: GET /api/v1/approvals/:id/comparison - Side-by-side comparison
router.get("/:id/comparison", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { source } = req.query as { source: string };
        const itemId = req.params.id;

        if (source === "loan_product") {
            const pendingProduct = await prisma.loanProduct.findFirst({
                where: { id: itemId, tenantId, status: "PENDING_APPROVAL" },
            });

            if (!pendingProduct) {
                res.status(404).json({ success: false, message: "Product not found" });
                return;
            }

            // Find active version for comparison
            const activeProduct = await prisma.loanProduct.findFirst({
                where: {
                    tenantId,
                    productCode: pendingProduct.productCode,
                    status: "ACTIVE",
                },
            });

            const comparison: any = {
                current: activeProduct || null,
                proposed: pendingProduct,
                changes: [],
            };

            if (activeProduct) {
                const fields = [
                    "productName", "category", "targetSegment", "description",
                    "repaymentStructure", "processingFeeType", "processingFeeValue",
                    "documentationCharge", "insurancePremiumType", "insurancePremiumValue",
                    "stampDutyPercent", "interestSchemeId",
                ];

                fields.forEach((field) => {
                    const currentVal = (activeProduct as any)[field];
                    const proposedVal = (pendingProduct as any)[field];
                    if (currentVal !== proposedVal) {
                        comparison.changes.push({
                            field,
                            current: currentVal,
                            proposed: proposedVal,
                        });
                    }
                });
            } else {
                // New product, all fields are changes
                comparison.changes.push({
                    field: "productName",
                    current: null,
                    proposed: pendingProduct.productName,
                });
            }

            res.json({ success: true, comparison });
        } else if (source === "interest_scheme") {
            const pendingScheme = await prisma.interestScheme.findFirst({
                where: { id: itemId, tenantId, status: "PENDING_APPROVAL" },
                include: { slabs: true },
            });

            if (!pendingScheme) {
                res.status(404).json({ success: false, message: "Scheme not found" });
                return;
            }

            const activeScheme = await prisma.interestScheme.findFirst({
                where: {
                    tenantId,
                    schemeCode: pendingScheme.schemeCode,
                    status: "ACTIVE",
                },
                include: { slabs: true },
            });

            const comparison: any = {
                current: activeScheme || null,
                proposed: pendingScheme,
                changes: [],
            };

            if (activeScheme) {
                const fields = ["schemeName", "interestMethod", "compoundingFreq", "slabApplicationMethod", "effectiveFromDate"];
                fields.forEach((field) => {
                    const currentVal = (activeScheme as any)[field];
                    const proposedVal = (pendingScheme as any)[field];
                    if (currentVal !== proposedVal) {
                        comparison.changes.push({
                            field,
                            current: currentVal,
                            proposed: proposedVal,
                        });
                    }
                });

                // Compare slabs
                if (JSON.stringify(activeScheme.slabs) !== JSON.stringify(pendingScheme.slabs)) {
                    comparison.changes.push({
                        field: "slabs",
                        current: activeScheme.slabs,
                        proposed: pendingScheme.slabs,
                    });
                }
            }

            res.json({ success: true, comparison });
        } else {
            res.status(400).json({ success: false, message: "Comparison not supported for this source type" });
        }
    } catch (err) {
        console.error("[Approvals Comparison]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// BRD v5.0 LN-A03: POST /api/v1/approvals/product/:id/approve - Approve loan product with reason codes
router.post("/product/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const { action, reasonCode, reason } = req.body as {
            action: "APPROVE" | "REJECT";
            reasonCode: string;
            reason?: string;
        };

        const product = await prisma.loanProduct.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });

        if (!product) {
            res.status(404).json({ success: false, message: "Product not found" });
            return;
        }

        // Find active version to supersede
        const activeVersion = action === "APPROVE" ? await prisma.loanProduct.findFirst({
            where: {
                tenantId,
                productCode: product.productCode,
                status: "ACTIVE",
            },
        }) : null;

        if (activeVersion && activeVersion.id !== product.id) {
            await prisma.loanProduct.update({
                where: { id: activeVersion.id },
                data: { status: "SUPERSEDED" },
            });
        }

        const updated = await prisma.loanProduct.update({
            where: { id: req.params.id },
            data: action === "APPROVE" ? {
                status: "ACTIVE",
                checkerId,
                approvedAt: new Date(),
                previousVersionId: activeVersion?.id,
                version: activeVersion ? activeVersion.version + 1 : 1,
            } : {
                status: "DRAFT",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: reason || reasonCode,
            },
        });

        res.json({ success: true, product: updated });
    } catch (err) {
        console.error("[Approvals Product Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// BRD v5.0 LN-A03: POST /api/v1/approvals/scheme/:id/approve - Approve interest scheme with reason codes
router.post("/scheme/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const { action, reasonCode, reason } = req.body as {
            action: "APPROVE" | "REJECT";
            reasonCode: string;
            reason?: string;
        };

        // Use existing interest scheme approve endpoint logic
        const scheme = await prisma.interestScheme.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });

        if (!scheme) {
            res.status(404).json({ success: false, message: "Scheme not found" });
            return;
        }

        const updated = await prisma.interestScheme.update({
            where: { id: req.params.id },
            data: action === "APPROVE" ? {
                status: "ACTIVE",
                checkerId,
                approvedAt: new Date(),
            } : {
                status: "DRAFT",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: reason || reasonCode,
            },
        });

        res.json({ success: true, scheme: updated });
    } catch (err) {
        console.error("[Approvals Scheme Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
