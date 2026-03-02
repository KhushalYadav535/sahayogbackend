/**
 * Module 2 — Governance (BOD, Committees, AGM, Resolutions, Compliance Events)
 */
import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

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
            agendaItems: z.array(z.string()).optional(),
            minutesDoc: z.string().optional(),
            status: z.string().optional(),
        }).parse(req.body);
        const rec = await prisma.agm.create({
            data: {
                tenantId,
                fiscalYear: data.fiscalYear,
                scheduledDate: data.scheduledDate,
                noticeDate: data.noticeDate,
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

// ─── Resolutions ───────────────────────────────────────────────────────────
router.get("/resolutions", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const list = await prisma.resolution.findMany({
            where: { tenantId },
            orderBy: { date: "desc" },
        });
        res.json({ success: true, data: list });
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

export default router;
