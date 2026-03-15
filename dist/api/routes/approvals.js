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
        // BRD v5.0 LN-A01: Loan Products pending approval
        const loanProducts = await prisma_1.default.loanProduct.findMany({
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
        const interestSchemes = await prisma_1.default.interestScheme.findMany({
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
// BRD v5.0 LN-A02: GET /api/v1/approvals/:id/comparison - Side-by-side comparison
router.get("/:id/comparison", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { source } = req.query;
        const itemId = req.params.id;
        if (source === "loan_product") {
            const pendingProduct = await prisma_1.default.loanProduct.findFirst({
                where: { id: itemId, tenantId, status: "PENDING_APPROVAL" },
            });
            if (!pendingProduct) {
                res.status(404).json({ success: false, message: "Product not found" });
                return;
            }
            // Find active version for comparison
            const activeProduct = await prisma_1.default.loanProduct.findFirst({
                where: {
                    tenantId,
                    productCode: pendingProduct.productCode,
                    status: "ACTIVE",
                },
            });
            const comparison = {
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
                    const currentVal = activeProduct[field];
                    const proposedVal = pendingProduct[field];
                    if (currentVal !== proposedVal) {
                        comparison.changes.push({
                            field,
                            current: currentVal,
                            proposed: proposedVal,
                        });
                    }
                });
            }
            else {
                // New product, all fields are changes
                comparison.changes.push({
                    field: "productName",
                    current: null,
                    proposed: pendingProduct.productName,
                });
            }
            res.json({ success: true, comparison });
        }
        else if (source === "interest_scheme") {
            const pendingScheme = await prisma_1.default.interestScheme.findFirst({
                where: { id: itemId, tenantId, status: "PENDING_APPROVAL" },
                include: { slabs: true },
            });
            if (!pendingScheme) {
                res.status(404).json({ success: false, message: "Scheme not found" });
                return;
            }
            const activeScheme = await prisma_1.default.interestScheme.findFirst({
                where: {
                    tenantId,
                    schemeCode: pendingScheme.schemeCode,
                    status: "ACTIVE",
                },
                include: { slabs: true },
            });
            const comparison = {
                current: activeScheme || null,
                proposed: pendingScheme,
                changes: [],
            };
            if (activeScheme) {
                const fields = ["schemeName", "interestMethod", "compoundingFreq", "slabApplicationMethod", "effectiveFromDate"];
                fields.forEach((field) => {
                    const currentVal = activeScheme[field];
                    const proposedVal = pendingScheme[field];
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
        }
        else {
            res.status(400).json({ success: false, message: "Comparison not supported for this source type" });
        }
    }
    catch (err) {
        console.error("[Approvals Comparison]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// BRD v5.0 LN-A03: POST /api/v1/approvals/product/:id/approve - Approve loan product with reason codes
router.post("/product/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const { action, reasonCode, reason } = req.body;
        const product = await prisma_1.default.loanProduct.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });
        if (!product) {
            res.status(404).json({ success: false, message: "Product not found" });
            return;
        }
        // Find active version to supersede
        const activeVersion = action === "APPROVE" ? await prisma_1.default.loanProduct.findFirst({
            where: {
                tenantId,
                productCode: product.productCode,
                status: "ACTIVE",
            },
        }) : null;
        if (activeVersion && activeVersion.id !== product.id) {
            await prisma_1.default.loanProduct.update({
                where: { id: activeVersion.id },
                data: { status: "SUPERSEDED" },
            });
        }
        const updated = await prisma_1.default.loanProduct.update({
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
    }
    catch (err) {
        console.error("[Approvals Product Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// BRD v5.0 LN-A03: POST /api/v1/approvals/scheme/:id/approve - Approve interest scheme with reason codes
router.post("/scheme/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const { action, reasonCode, reason } = req.body;
        // Use existing interest scheme approve endpoint logic
        const scheme = await prisma_1.default.interestScheme.findFirst({
            where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
        });
        if (!scheme) {
            res.status(404).json({ success: false, message: "Scheme not found" });
            return;
        }
        const updated = await prisma_1.default.interestScheme.update({
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
    }
    catch (err) {
        console.error("[Approvals Scheme Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=approvals.js.map