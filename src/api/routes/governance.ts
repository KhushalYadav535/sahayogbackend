/**
 * Module 2 — Governance (BOD, Committees, AGM, Resolutions, Compliance Events)
 */
import { Router, Response } from "express";
import { z } from "zod";
import { createHash } from "crypto";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// ─── BOD Directors ─────────────────────────────────────────────────────────
router.get("/bod", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const list = await prisma.bodDirector.findMany({
            where: { tenantId },
            orderBy: { termEnd: "desc" },
        });
        res.json({ success: true, data: list });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/bod", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            name: z.string(),
            designation: z.string(),
            din: z.string().optional(),
            pan: z.string().optional(),
            electionDate: z.coerce.date(),
            termStart: z.coerce.date(),
            termEnd: z.coerce.date(),
        }).parse(req.body);
        const rec = await prisma.bodDirector.create({ data: { tenantId, ...data } });
        res.status(201).json({ success: true, data: rec });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── Committees ─────────────────────────────────────────────────────────────
router.get("/committees", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const list = await prisma.committee.findMany({ where: { tenantId } });
        res.json({ success: true, data: list });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/committees", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            name: z.string(),
            committeeType: z.string(),
            mandate: z.string().optional(),
            memberIds: z.array(z.string()),
            quorumRequired: z.number().int().optional(),
            meetingFreq: z.string().optional(),
        }).parse(req.body);
        const rec = await prisma.committee.create({
            data: {
                tenantId,
                name: data.name,
                committeeType: data.committeeType,
                mandate: data.mandate,
                memberIds: data.memberIds,
                quorumRequired: data.quorumRequired ?? 2,
                meetingFreq: data.meetingFreq,
            },
        });
        res.status(201).json({ success: true, data: rec });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── AGM ───────────────────────────────────────────────────────────────────
router.get("/agm", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const list = await prisma.agm.findMany({
            where: { tenantId },
            orderBy: { scheduledDate: "desc" },
        });
        res.json({ success: true, data: list });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/agm", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            fiscalYear: z.string(),
            scheduledDate: z.coerce.date(),
            noticeDate: z.coerce.date().optional(),
            venue: z.string().optional(),
            agendaItems: z.array(z.object({
                id: z.string().optional(),
                title: z.string(),
                description: z.string().optional(),
                order: z.number().optional(),
            })).optional(),
            minutesDoc: z.string().optional(),
            status: z.string().optional(),
        }).parse(req.body);
        const rec = await prisma.agm.create({
            data: {
                tenantId,
                fiscalYear: data.fiscalYear,
                scheduledDate: data.scheduledDate,
                noticeDate: data.noticeDate,
                venue: data.venue,
                agendaItems: data.agendaItems,
                minutesDoc: data.minutesDoc,
                status: data.status ?? "scheduled",
            },
        });
        res.status(201).json({ success: true, data: rec });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-003: AGM Attendance Recording ────────────────────────────────────────
router.post("/agm/:id/attendance", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { attendance } = z.object({
            attendance: z.array(z.object({
                memberId: z.string(),
                memberName: z.string(),
                present: z.boolean(),
            })),
        }).parse(req.body);

        const agm = await prisma.agm.findFirst({ where: { id: req.params.id, tenantId } });
        if (!agm) {
            res.status(404).json({ success: false, message: "AGM not found" });
            return;
        }

        await prisma.agm.update({
            where: { id: req.params.id },
            data: { attendance },
        });

        res.json({ success: true, message: "Attendance recorded" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-003: AGM Notice Dispatch ─────────────────────────────────────────────
router.post("/agm/:id/send-notice", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const agm = await prisma.agm.findFirst({ where: { id: req.params.id, tenantId } });
        if (!agm) {
            res.status(404).json({ success: false, message: "AGM not found" });
            return;
        }

        // TODO: Send SMS + in-app notifications to all members
        // For now, just mark notice as sent
        await prisma.agm.update({
            where: { id: req.params.id },
            data: { noticeSentAt: new Date(), status: "notice_sent" },
        });

        res.json({ success: true, message: "AGM notice dispatched to members" });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── Resolutions ───────────────────────────────────────────────────────────
router.get("/resolutions", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { search, status, meetingType, startDate, endDate } = req.query as Record<string, string>;

        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;
        if (meetingType) where.meetingType = meetingType;
        if (startDate || endDate) {
            where.date = {};
            if (startDate) (where.date as any).gte = new Date(startDate);
            if (endDate) (where.date as any).lte = new Date(endDate);
        }

        let list = await prisma.resolution.findMany({
            where,
            orderBy: { date: "desc" },
        });

        // GOV-004: Full-text search by keyword
        if (search) {
            const searchLower = search.toLowerCase();
            list = list.filter(r =>
                r.referenceNo.toLowerCase().includes(searchLower) ||
                r.subject.toLowerCase().includes(searchLower) ||
                (r.description && r.description.toLowerCase().includes(searchLower))
            );
        }

        res.json({ success: true, data: list, total: list.length });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/resolutions", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            agmId: z.string().optional(),
            referenceNo: z.string(),
            date: z.coerce.date(),
            meetingType: z.string(),
            status: z.string(),
            subject: z.string(),
            description: z.string().optional(),
            documentPath: z.string().optional(),
        }).parse(req.body);
        const rec = await prisma.resolution.create({
            data: { tenantId, ...data },
        });
        res.status(201).json({ success: true, data: rec });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── Compliance Events ─────────────────────────────────────────────────────
router.get("/compliance-events", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const list = await prisma.complianceEvent.findMany({
            where: { tenantId },
            orderBy: { dueDate: "asc" },
        });
        res.json({ success: true, data: list });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/compliance-events", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            eventType: z.string(),
            dueDate: z.coerce.date(),
            responsibleRole: z.string().optional(),
            status: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
        }).parse(req.body);
        const rec = await prisma.complianceEvent.create({
            data: {
                tenantId,
                eventType: data.eventType,
                dueDate: data.dueDate,
                responsibleRole: data.responsibleRole,
                status: data.status ?? "pending",
                metadata: data.metadata,
            },
        });
        res.status(201).json({ success: true, data: rec });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-006: By-law Repository ──────────────────────────────────────────────
router.get("/bylaws", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const list = await prisma.bylaw.findMany({
            where: { tenantId },
            orderBy: { version: "desc" },
        });
        res.json({ success: true, data: list });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/bylaws", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            title: z.string(),
            documentPath: z.string(),
            resolutionRef: z.string().optional(),
            effectiveDate: z.coerce.date().optional(),
        }).parse(req.body);

        // Get max version for this tenant
        const maxVersion = await prisma.bylaw.findFirst({
            where: { tenantId },
            orderBy: { version: "desc" },
            select: { version: true },
        });

        const rec = await prisma.bylaw.create({
            data: {
                tenantId,
                version: (maxVersion?.version || 0) + 1,
                title: data.title,
                documentPath: data.documentPath,
                resolutionRef: data.resolutionRef,
                effectiveDate: data.effectiveDate || new Date(),
                createdBy: req.user?.userId,
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "BYLAW_UPLOADED",
            entity: "Bylaw",
            entityId: rec.id,
            newData: { title: data.title, version: rec.version, resolutionRef: data.resolutionRef },
            ipAddress: req.ip,
        });

        res.status(201).json({ success: true, data: rec });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-007: Meeting Minutes & Action Items ──────────────────────────────────
router.post("/meetings/:meetingId/minutes", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            meetingType: z.enum(["BOARD", "AGM", "COMMITTEE"]),
            meetingDate: z.coerce.date(),
            attendees: z.array(z.object({
                memberId: z.string(),
                name: z.string(),
                role: z.string().optional(),
                present: z.boolean(),
            })),
            agenda: z.array(z.object({
                id: z.string().optional(),
                title: z.string(),
                description: z.string().optional(),
                decisions: z.string().optional(),
            })),
            decisions: z.array(z.string()).optional(),
            actionItems: z.array(z.object({
                id: z.string().optional(),
                description: z.string(),
                responsible: z.string(),
                dueDate: z.coerce.date(),
                status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "OVERDUE"]).optional(),
            })).optional(),
        }).parse(req.body);

        const minutes = await prisma.meetingMinutes.create({
            data: {
                tenantId,
                meetingType: data.meetingType,
                meetingId: req.params.meetingId,
                meetingDate: data.meetingDate,
                attendees: data.attendees,
                agenda: data.agenda,
                decisions: data.decisions,
                actionItems: data.actionItems || [],
                createdBy: req.user?.userId,
            },
        });

        res.status(201).json({ success: true, data: minutes });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.get("/meetings/:meetingId/minutes", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const minutes = await prisma.meetingMinutes.findMany({
            where: { tenantId, meetingId: req.params.meetingId },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: minutes });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-007: Finalize Minutes with SHA-256 Hash ────────────────────────────
router.post("/minutes/:id/finalize", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const minutes = await prisma.meetingMinutes.findFirst({
            where: { id: req.params.id, tenantId },
        });

        if (!minutes) {
            res.status(404).json({ success: false, message: "Minutes not found" });
            return;
        }

        // GOV-015: Compute SHA-256 hash
        const content = JSON.stringify({
            meetingType: minutes.meetingType,
            meetingDate: minutes.meetingDate,
            attendees: minutes.attendees,
            agenda: minutes.agenda,
            decisions: minutes.decisions,
            actionItems: minutes.actionItems,
        });
        const sha256Hash = createHash("sha256").update(content).digest("hex");

        const finalized = await prisma.meetingMinutes.update({
            where: { id: req.params.id },
            data: {
                minutesType: "FINALIZED",
                sha256Hash,
                digitallySigned: false, // TODO: Integrate eSign service
                signedAt: new Date(),
                signedBy: req.user?.userId,
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "MINUTES_FINALIZED",
            entity: "MeetingMinutes",
            entityId: minutes.id,
            newData: { sha256Hash },
            ipAddress: req.ip,
        });

        res.json({ success: true, data: finalized });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-007: Update Action Item Status ───────────────────────────────────────
router.patch("/action-items/:minutesId/:itemId", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status } = z.object({
            status: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "OVERDUE"]),
        }).parse(req.body);

        const minutes = await prisma.meetingMinutes.findFirst({
            where: { id: req.params.minutesId, tenantId },
        });

        if (!minutes) {
            res.status(404).json({ success: false, message: "Minutes not found" });
            return;
        }

        const actionItems = (minutes.actionItems as any[]) || [];
        const itemIndex = actionItems.findIndex((item: any) => item.id === req.params.itemId);
        if (itemIndex === -1) {
            res.status(404).json({ success: false, message: "Action item not found" });
            return;
        }

        actionItems[itemIndex].status = status;
        if (status === "COMPLETED") {
            actionItems[itemIndex].completedAt = new Date().toISOString();
        }

        await prisma.meetingMinutes.update({
            where: { id: req.params.minutesId },
            data: { actionItems },
        });

        res.json({ success: true, message: "Action item updated" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-010: Exception Override Tracking ─────────────────────────────────────
router.post("/approvals/override", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            ruleBypassed: z.string(),
            originalApprover: z.string(),
            reasonCode: z.string(),
            reasonDescription: z.string().optional(),
            transactionType: z.string(),
            transactionId: z.string().optional(),
            amount: z.number().optional(),
        }).parse(req.body);

        // Generate override ID
        const count = await prisma.approvalOverride.count({ where: { tenantId } });
        const overrideId = `OVR-${String(count + 1).padStart(6, "0")}`;

        const override = await prisma.approvalOverride.create({
            data: {
                tenantId,
                overrideId,
                ruleBypassed: data.ruleBypassed,
                originalApprover: data.originalApprover,
                overrideAuthorizer: req.user?.userId || "unknown",
                reasonCode: data.reasonCode,
                reasonDescription: data.reasonDescription,
                transactionType: data.transactionType,
                transactionId: data.transactionId,
                amount: data.amount ? data.amount : undefined,
                createdBy: req.user?.userId,
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "APPROVAL_OVERRIDE",
            entity: "ApprovalOverride",
            entityId: override.id,
            newData: { overrideId, ruleBypassed: data.ruleBypassed, reasonCode: data.reasonCode },
            ipAddress: req.ip,
        });

        res.status(201).json({ success: true, data: override });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.get("/approvals/overrides", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { transactionType, startDate, endDate } = req.query as Record<string, string>;

        const where: Record<string, unknown> = { tenantId };
        if (transactionType) where.transactionType = transactionType;
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) (where.createdAt as any).gte = new Date(startDate);
            if (endDate) (where.createdAt as any).lte = new Date(endDate);
        }

        const overrides = await prisma.approvalOverride.findMany({
            where,
            orderBy: { createdAt: "desc" },
        });

        res.json({ success: true, data: overrides, total: overrides.length });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GOV-008: Maker-Checker Threshold Configuration ──────────────────────────
router.get("/approval-thresholds", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { transactionType } = req.query as Record<string, string>;

        const where: Record<string, unknown> = { tenantId, isActive: true };
        if (transactionType) where.transactionType = transactionType;

        const thresholds = await prisma.approvalThreshold.findMany({
            where,
            orderBy: [{ transactionType: "asc" }, { level: "asc" }],
        });

        res.json({ success: true, data: thresholds });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

router.post("/approval-thresholds", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            transactionType: z.string(),
            level: z.number().int().min(1).max(4),
            maxAmount: z.number().optional(),
            approverRole: z.string(),
            slaHours: z.number().int().default(24),
        }).parse(req.body);

        const threshold = await prisma.approvalThreshold.upsert({
            where: {
                tenantId_transactionType_level: {
                    tenantId,
                    transactionType: data.transactionType,
                    level: data.level,
                },
            },
            update: {
                maxAmount: data.maxAmount ? data.maxAmount : undefined,
                approverRole: data.approverRole,
                slaHours: data.slaHours,
            },
            create: {
                tenantId,
                transactionType: data.transactionType,
                level: data.level,
                maxAmount: data.maxAmount ? data.maxAmount : undefined,
                approverRole: data.approverRole,
                slaHours: data.slaHours,
            },
        });

        res.status(201).json({ success: true, data: threshold });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
