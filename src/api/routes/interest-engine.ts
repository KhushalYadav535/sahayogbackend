/**
 * Module 16 — Interest Engine & Rate Management (BRD v4.0)
 * INT-001, INT-001A, INT-002, INT-003, INT-004A, INT-004B, INT-006, INT-007, INT-009, INT-010, INT-012, INT-013
 */

import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// ─── INT-001: Interest Rate Scheme Management ─────────────────────────────────────

// GET /api/v1/interest/schemes — List all schemes
router.get("/schemes", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { productType, status } = req.query;

        const schemes = await prisma.interestScheme.findMany({
            where: {
                tenantId,
                ...(productType && { productType: String(productType) }),
                ...(status && { status: String(status) }),
            },
            include: {
                slabs: { orderBy: { minAmount: "asc" } },
                _count: { select: { accruals: true } },
            },
            orderBy: { effectiveFromDate: "desc" },
        });

        res.json({ success: true, schemes });
    } catch (err) {
        console.error("[Interest Schemes GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/interest/schemes/pending — Get pending approvals (must be before /schemes/:id)
router.get("/schemes/pending", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const schemes = await prisma.interestScheme.findMany({
            where: {
                tenantId,
                status: "PENDING_APPROVAL",
            },
            include: {
                slabs: true,
            },
            orderBy: { submittedAt: "asc" },
        });

        res.json({ success: true, schemes });
    } catch (err) {
        console.error("[Pending Schemes GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/interest/schemes/audit — Get audit trail (must be before /schemes/:id)
router.get("/schemes/audit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { schemeCode, changeType, fromDate, toDate } = req.query;

        // Build where clause
        const where: any = {
            scheme: {
                tenantId,
                ...(schemeCode && { schemeCode: String(schemeCode) }),
            },
            ...(changeType && { changeType: String(changeType) }),
        };

        // Date range filter
        if (fromDate || toDate) {
            where.changeDate = {};
            if (fromDate) {
                where.changeDate.gte = new Date(String(fromDate));
            }
            if (toDate) {
                const to = new Date(String(toDate));
                to.setHours(23, 59, 59, 999); // End of day
                where.changeDate.lte = to;
            }
        }

        const auditRecords = await prisma.interestSchemeAudit.findMany({
            where,
            include: {
                scheme: {
                    select: {
                        id: true,
                        schemeCode: true,
                        schemeName: true,
                    },
                },
            },
            orderBy: { changeDate: "desc" },
        });

        // Format response with user names (if available)
        const records = auditRecords.map((record) => ({
            id: record.id,
            schemeCode: record.scheme.schemeCode,
            schemeName: record.scheme.schemeName,
            changeType: record.changeType,
            oldParameters: JSON.parse(record.oldParameters || "{}"),
            newParameters: JSON.parse(record.newParameters || "{}"),
            changedBy: record.changedBy,
            changedByName: null, // TODO: Join with User table if needed
            approvedBy: record.approvedBy || undefined,
            approvedByName: null, // TODO: Join with User table if needed
            changeDate: record.changeDate.toISOString(),
            effectiveDate: record.effectiveDate.toISOString(),
            approvalDate: record.approvalDate?.toISOString(),
            rejectionReason: record.rejectionReason || undefined,
            rateDeltaPct: record.rateDeltaPct ? Number(record.rateDeltaPct) : undefined,
        }));

        res.json({ success: true, records });
    } catch (err) {
        console.error("[Interest Scheme Audit GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/interest/schemes/audit/export — Export audit trail (must be before /schemes/:id)
router.get("/schemes/audit/export", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { schemeCode, changeType, fromDate, toDate, format } = req.query;

        // Build where clause (same as audit endpoint)
        const where: any = {
            scheme: {
                tenantId,
                ...(schemeCode && { schemeCode: String(schemeCode) }),
            },
            ...(changeType && { changeType: String(changeType) }),
        };

        if (fromDate || toDate) {
            where.changeDate = {};
            if (fromDate) {
                where.changeDate.gte = new Date(String(fromDate));
            }
            if (toDate) {
                const to = new Date(String(toDate));
                to.setHours(23, 59, 59, 999);
                where.changeDate.lte = to;
            }
        }

        const auditRecords = await prisma.interestSchemeAudit.findMany({
            where,
            include: {
                scheme: {
                    select: {
                        schemeCode: true,
                        schemeName: true,
                    },
                },
            },
            orderBy: { changeDate: "desc" },
        });

        // Format records
        const records = auditRecords.map((record) => ({
            schemeCode: record.scheme.schemeCode,
            schemeName: record.scheme.schemeName,
            changeType: record.changeType,
            changeDate: record.changeDate.toISOString(),
            effectiveDate: record.effectiveDate.toISOString(),
            changedBy: record.changedBy,
            approvedBy: record.approvedBy || "",
            rateDeltaPct: record.rateDeltaPct ? Number(record.rateDeltaPct) : null,
        }));

        const exportFormat = format === "excel" ? "excel" : "pdf";

        if (exportFormat === "excel") {
            // TODO: Generate Excel file using a library like exceljs
            // For now, return JSON that frontend can convert
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename=interest-scheme-audit-${Date.now()}.json`);
            res.json({ success: true, records, format: "excel" });
        } else {
            // TODO: Generate PDF using a library like pdfkit or puppeteer
            // For now, return JSON
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename=interest-scheme-audit-${Date.now()}.json`);
            res.json({ success: true, records, format: "pdf" });
        }
    } catch (err) {
        console.error("[Interest Scheme Audit Export GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/interest/schemes/:id — Get scheme details
router.get("/schemes/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const scheme = await prisma.interestScheme.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                slabs: { orderBy: { minAmount: "asc" } },
                auditLogs: { orderBy: { changeDate: "desc" }, take: 10 },
            },
        });

        if (!scheme) {
            res.status(404).json({ success: false, message: "Scheme not found" });
            return;
        }

        res.json({ success: true, scheme });
    } catch (err) {
        console.error("[Interest Scheme GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/interest/schemes — Create new scheme (Maker)
router.post("/schemes", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const makerId = req.user!.id;

        const data = z.object({
            schemeCode: z.string().min(1).max(20),
            schemeName: z.string().min(1).max(200),
            productType: z.enum(["SB", "FDR", "RD", "Loan"]),
            interestMethod: z.enum(["SIMPLE", "REDUCING_BALANCE", "FLAT"]),
            compoundingFreq: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY", "SIMPLE"]),
            slabApplicationMethod: z.enum(["FLAT", "MARGINAL"]).default("FLAT"),
            effectiveFromDate: z.string().transform((s) => new Date(s)),
            effectiveToDate: z.string().optional().transform((s) => s ? new Date(s) : undefined),
            slabs: z.array(z.object({
                minAmount: z.number().optional(),
                maxAmount: z.number().optional(),
                minTenureDays: z.number().optional(),
                maxTenureDays: z.number().optional(),
                rate: z.number().min(0).max(100),
            })).optional(),
        }).parse(req.body);

        // Validate effective date is today or future (set time to start of day for comparison)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const effectiveDate = new Date(data.effectiveFromDate);
        effectiveDate.setHours(0, 0, 0, 0);
        
        if (effectiveDate < today) {
            res.status(400).json({ success: false, message: "Effective from date cannot be in the past" });
            return;
        }

        // Check for overlapping schemes
        const overlapping = await prisma.interestScheme.findFirst({
            where: {
                tenantId,
                productType: data.productType,
                status: "ACTIVE",
                OR: [
                    { effectiveToDate: null },
                    { effectiveToDate: { gte: data.effectiveFromDate } },
                ],
            },
        });

        if (overlapping && !data.effectiveToDate) {
            res.status(409).json({ success: false, message: "An active scheme already exists for this product type" });
            return;
        }

        const scheme = await prisma.interestScheme.create({
            data: {
                tenantId,
                schemeCode: data.schemeCode,
                schemeName: data.schemeName,
                productType: data.productType,
                interestMethod: data.interestMethod,
                compoundingFreq: data.compoundingFreq,
                slabApplicationMethod: data.slabApplicationMethod,
                calculationBasis: "ACTUAL_365", // From platform parameter
                effectiveFromDate: data.effectiveFromDate,
                effectiveToDate: data.effectiveToDate || null,
                status: "DRAFT",
                makerId,
            },
            include: { slabs: true },
        });

        // Create slabs if provided
        if (data.slabs && data.slabs.length > 0) {
            await prisma.interestSchemeSlab.createMany({
                data: data.slabs.map((slab) => ({
                    schemeId: scheme.id,
                    minAmount: slab.minAmount ? String(slab.minAmount) : null,
                    maxAmount: slab.maxAmount ? String(slab.maxAmount) : null,
                    minTenureDays: slab.minTenureDays || null,
                    maxTenureDays: slab.maxTenureDays || null,
                    rate: String(slab.rate),
                })),
            });
        }

        await createAuditLog(tenantId, "INTEREST_SCHEME_CREATED", {
            schemeId: scheme.id,
            schemeCode: scheme.schemeCode,
            makerId,
        });

        res.status(201).json({ success: true, scheme });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors, message: err.errors.map((e) => e.message).join("; ") });
            return;
        }
        console.error("[Interest Scheme POST]", err);
        const msg = err instanceof Error ? err.message : "Server error";
        res.status(500).json({ success: false, message: msg });
    }
});

// PUT /api/v1/interest/schemes/:id/submit — Submit for approval (Maker)
router.put("/schemes/:id/submit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const schemeId = req.params.id;

        const scheme = await prisma.interestScheme.findFirst({
            where: { id: schemeId, tenantId },
        });

        if (!scheme) {
            res.status(404).json({ success: false, message: "Scheme not found" });
            return;
        }

        if (scheme.status !== "DRAFT") {
            res.status(400).json({ success: false, message: `Scheme is in ${scheme.status} state and cannot be submitted` });
            return;
        }

        // Calculate rate delta if modifying existing scheme
        let rateDeltaPct: number | null = null;
        if (scheme.makerId) {
            // This is a modification - calculate delta
            const oldScheme = await prisma.interestSchemeAudit.findFirst({
                where: { schemeId, changeType: "MODIFIED" },
                orderBy: { changeDate: "desc" },
            });
            // TODO: Calculate delta from old parameters
        }

        const updated = await prisma.interestScheme.update({
            where: { id: schemeId },
            data: {
                status: "PENDING_APPROVAL",
                submittedAt: new Date(),
                rateDeltaPct: rateDeltaPct ? String(rateDeltaPct) : null,
            },
        });

        // TODO: Send notification to checker

        await createAuditLog(tenantId, "INTEREST_SCHEME_SUBMITTED", {
            schemeId,
            makerId: req.user!.id,
        });

        res.json({ success: true, scheme: updated });
    } catch (err) {
        console.error("[Interest Scheme Submit]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/interest/schemes/:id/approve — Approve scheme (Checker)
router.put("/schemes/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const schemeId = req.params.id;

        const scheme = await prisma.interestScheme.findFirst({
            where: { id: schemeId, tenantId },
        });

        if (!scheme) {
            res.status(404).json({ success: false, message: "Scheme not found" });
            return;
        }

        if (scheme.status !== "PENDING_APPROVAL") {
            res.status(400).json({ success: false, message: `Scheme is in ${scheme.status} state and cannot be approved` });
            return;
        }

        // Check maker != checker
        if (scheme.makerId === checkerId) {
            res.status(400).json({ success: false, message: "Checker must be different from Maker" });
            return;
        }

        // If activating a new scheme, supersede existing ACTIVE scheme
        if (scheme.status === "PENDING_APPROVAL") {
            await prisma.interestScheme.updateMany({
                where: {
                    tenantId,
                    productType: scheme.productType,
                    status: "ACTIVE",
                },
                data: { status: "SUPERSEDED" },
            });
        }

        const updated = await prisma.interestScheme.update({
            where: { id: schemeId },
            data: {
                status: "ACTIVE",
                checkerId,
                approvedAt: new Date(),
            },
        });

        // Create audit log - ensure changedBy is always set
        const changedByUserId = scheme.makerId || checkerId;
        if (!changedByUserId) {
            throw new Error("Cannot create audit log: missing makerId and checkerId");
        }

        await prisma.interestSchemeAudit.create({
            data: {
                schemeId,
                changeType: scheme.makerId ? "MODIFIED" : "CREATED",
                oldParameters: "{}", // TODO: Get from previous version
                newParameters: JSON.stringify({
                    schemeCode: scheme.schemeCode,
                    schemeName: scheme.schemeName,
                    productType: scheme.productType,
                    interestMethod: scheme.interestMethod,
                    compoundingFreq: scheme.compoundingFreq,
                    slabApplicationMethod: scheme.slabApplicationMethod,
                    effectiveFromDate: scheme.effectiveFromDate,
                }),
                changedBy: changedByUserId,
                approvedBy: checkerId,
                changeDate: scheme.submittedAt || new Date(),
                effectiveDate: scheme.effectiveFromDate,
                approvalDate: new Date(),
                rateDeltaPct: scheme.rateDeltaPct ? String(scheme.rateDeltaPct) : null,
            },
        });

        await createAuditLog(tenantId, "INTEREST_SCHEME_APPROVED", {
            schemeId,
            checkerId,
        });

        res.json({ success: true, scheme: updated });
    } catch (err) {
        console.error("[Interest Scheme Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/interest/schemes/:id/reject — Reject scheme (Checker)
router.put("/schemes/:id/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const schemeId = req.params.id;

        const data = z.object({
            reason: z.string().min(1),
        }).parse(req.body);

        const scheme = await prisma.interestScheme.findFirst({
            where: { id: schemeId, tenantId },
        });

        if (!scheme) {
            res.status(404).json({ success: false, message: "Scheme not found" });
            return;
        }

        if (scheme.status !== "PENDING_APPROVAL") {
            res.status(400).json({ success: false, message: `Scheme is in ${scheme.status} state` });
            return;
        }

        const updated = await prisma.interestScheme.update({
            where: { id: schemeId },
            data: {
                status: "REJECTED",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: data.reason,
            },
        });

        await createAuditLog(tenantId, "INTEREST_SCHEME_REJECTED", {
            schemeId,
            checkerId,
            reason: data.reason,
        });

        res.json({ success: true, scheme: updated });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Interest Scheme Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── INT-011: Interest Simulation ──────────────────────────────────────────────────

// POST /api/v1/interest/simulate — Simulate interest calculation
router.post("/simulate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            productType: z.enum(["SB", "FDR", "RD", "Loan"]),
            principal: z.number().min(0),
            rate: z.number().min(0).max(100).optional(),
            tenureDays: z.number().optional(),
            tenureMonths: z.number().optional(),
            compoundingFreq: z.enum(["MONTHLY", "QUARTERLY", "ANNUALLY", "SIMPLE"]).optional(),
            memberAge: z.number().optional(),
        }).parse(req.body);

        // TODO: Implement simulation logic using active scheme
        // This is a placeholder - full implementation requires scheme lookup and calculation

        res.json({
            success: true,
            simulation: {
                totalInterest: 0,
                maturityValue: data.principal,
                emiSchedule: null,
                tdsEstimate: null,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Interest Simulate]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
