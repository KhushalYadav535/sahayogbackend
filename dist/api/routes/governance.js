"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Module 2 — Governance (BOD, Committees, AGM, Resolutions, Compliance Events)
 */
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ─── BOD Directors ─────────────────────────────────────────────────────────
router.get("/bod", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const list = await prisma_1.default.bodDirector.findMany({
            where: { tenantId },
            orderBy: { termEnd: "desc" },
        });
        res.json({ success: true, data: list });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/bod", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            name: zod_1.z.string(),
            designation: zod_1.z.string(),
            din: zod_1.z.string().optional(),
            pan: zod_1.z.string().optional(),
            electionDate: zod_1.z.coerce.date(),
            termStart: zod_1.z.coerce.date(),
            termEnd: zod_1.z.coerce.date(),
        }).parse(req.body);
        const rec = await prisma_1.default.bodDirector.create({ data: { tenantId, ...data } });
        res.status(201).json({ success: true, data: rec });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── Committees ─────────────────────────────────────────────────────────────
router.get("/committees", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const list = await prisma_1.default.committee.findMany({ where: { tenantId } });
        res.json({ success: true, data: list });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/committees", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            name: zod_1.z.string(),
            committeeType: zod_1.z.string(),
            mandate: zod_1.z.string().optional(),
            memberIds: zod_1.z.array(zod_1.z.string()),
            quorumRequired: zod_1.z.number().int().optional(),
            meetingFreq: zod_1.z.string().optional(),
        }).parse(req.body);
        const rec = await prisma_1.default.committee.create({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── AGM ───────────────────────────────────────────────────────────────────
router.get("/agm", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const list = await prisma_1.default.agm.findMany({
            where: { tenantId },
            orderBy: { scheduledDate: "desc" },
        });
        res.json({ success: true, data: list });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/agm", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            fiscalYear: zod_1.z.string(),
            scheduledDate: zod_1.z.coerce.date(),
            noticeDate: zod_1.z.coerce.date().optional(),
            agendaItems: zod_1.z.array(zod_1.z.string()).optional(),
            minutesDoc: zod_1.z.string().optional(),
            status: zod_1.z.string().optional(),
        }).parse(req.body);
        const rec = await prisma_1.default.agm.create({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── Resolutions ───────────────────────────────────────────────────────────
router.get("/resolutions", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const list = await prisma_1.default.resolution.findMany({
            where: { tenantId },
            orderBy: { date: "desc" },
        });
        res.json({ success: true, data: list });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/resolutions", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            agmId: zod_1.z.string().optional(),
            referenceNo: zod_1.z.string(),
            date: zod_1.z.coerce.date(),
            meetingType: zod_1.z.string(),
            status: zod_1.z.string(),
            subject: zod_1.z.string(),
            description: zod_1.z.string().optional(),
            documentPath: zod_1.z.string().optional(),
        }).parse(req.body);
        const rec = await prisma_1.default.resolution.create({
            data: { tenantId, ...data },
        });
        res.status(201).json({ success: true, data: rec });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── Compliance Events ─────────────────────────────────────────────────────
router.get("/compliance-events", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const list = await prisma_1.default.complianceEvent.findMany({
            where: { tenantId },
            orderBy: { dueDate: "asc" },
        });
        res.json({ success: true, data: list });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/compliance-events", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            eventType: zod_1.z.string(),
            dueDate: zod_1.z.coerce.date(),
            responsibleRole: zod_1.z.string().optional(),
            status: zod_1.z.string().optional(),
            metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
        }).parse(req.body);
        const rec = await prisma_1.default.complianceEvent.create({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=governance.js.map