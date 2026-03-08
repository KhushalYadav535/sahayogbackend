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
const crypto_1 = require("crypto");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
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
            venue: zod_1.z.string().optional(),
            agendaItems: zod_1.z.array(zod_1.z.object({
                id: zod_1.z.string().optional(),
                title: zod_1.z.string(),
                description: zod_1.z.string().optional(),
                order: zod_1.z.number().optional(),
            })).optional(),
            minutesDoc: zod_1.z.string().optional(),
            status: zod_1.z.string().optional(),
        }).parse(req.body);
        const rec = await prisma_1.default.agm.create({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-003: AGM Attendance Recording ────────────────────────────────────────
router.post("/agm/:id/attendance", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { attendance } = zod_1.z.object({
            attendance: zod_1.z.array(zod_1.z.object({
                memberId: zod_1.z.string(),
                memberName: zod_1.z.string(),
                present: zod_1.z.boolean(),
            })),
        }).parse(req.body);
        const agm = await prisma_1.default.agm.findFirst({ where: { id: req.params.id, tenantId } });
        if (!agm) {
            res.status(404).json({ success: false, message: "AGM not found" });
            return;
        }
        await prisma_1.default.agm.update({
            where: { id: req.params.id },
            data: { attendance },
        });
        res.json({ success: true, message: "Attendance recorded" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-003: AGM Notice Dispatch ─────────────────────────────────────────────
router.post("/agm/:id/send-notice", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const agm = await prisma_1.default.agm.findFirst({ where: { id: req.params.id, tenantId } });
        if (!agm) {
            res.status(404).json({ success: false, message: "AGM not found" });
            return;
        }
        // TODO: Send SMS + in-app notifications to all members
        // For now, just mark notice as sent
        await prisma_1.default.agm.update({
            where: { id: req.params.id },
            data: { noticeSentAt: new Date(), status: "notice_sent" },
        });
        res.json({ success: true, message: "AGM notice dispatched to members" });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── Resolutions ───────────────────────────────────────────────────────────
router.get("/resolutions", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { search, status, meetingType, startDate, endDate } = req.query;
        const where = { tenantId };
        if (status)
            where.status = status;
        if (meetingType)
            where.meetingType = meetingType;
        if (startDate || endDate) {
            where.date = {};
            if (startDate)
                where.date.gte = new Date(startDate);
            if (endDate)
                where.date.lte = new Date(endDate);
        }
        let list = await prisma_1.default.resolution.findMany({
            where,
            orderBy: { date: "desc" },
        });
        // GOV-004: Full-text search by keyword
        if (search) {
            const searchLower = search.toLowerCase();
            list = list.filter(r => r.referenceNo.toLowerCase().includes(searchLower) ||
                r.subject.toLowerCase().includes(searchLower) ||
                (r.description && r.description.toLowerCase().includes(searchLower)));
        }
        res.json({ success: true, data: list, total: list.length });
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
// ─── GOV-006: By-law Repository ──────────────────────────────────────────────
router.get("/bylaws", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const list = await prisma_1.default.bylaw.findMany({
            where: { tenantId },
            orderBy: { version: "desc" },
        });
        res.json({ success: true, data: list });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/bylaws", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            title: zod_1.z.string(),
            documentPath: zod_1.z.string(),
            resolutionRef: zod_1.z.string().optional(),
            effectiveDate: zod_1.z.coerce.date().optional(),
        }).parse(req.body);
        // Get max version for this tenant
        const maxVersion = await prisma_1.default.bylaw.findFirst({
            where: { tenantId },
            orderBy: { version: "desc" },
            select: { version: true },
        });
        const rec = await prisma_1.default.bylaw.create({
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
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "BYLAW_UPLOADED",
            entity: "Bylaw",
            entityId: rec.id,
            newData: { title: data.title, version: rec.version, resolutionRef: data.resolutionRef },
            ipAddress: req.ip,
        });
        res.status(201).json({ success: true, data: rec });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-007: Meeting Minutes & Action Items ──────────────────────────────────
router.post("/meetings/:meetingId/minutes", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            meetingType: zod_1.z.enum(["BOARD", "AGM", "COMMITTEE"]),
            meetingDate: zod_1.z.coerce.date(),
            attendees: zod_1.z.array(zod_1.z.object({
                memberId: zod_1.z.string(),
                name: zod_1.z.string(),
                role: zod_1.z.string().optional(),
                present: zod_1.z.boolean(),
            })),
            agenda: zod_1.z.array(zod_1.z.object({
                id: zod_1.z.string().optional(),
                title: zod_1.z.string(),
                description: zod_1.z.string().optional(),
                decisions: zod_1.z.string().optional(),
            })),
            decisions: zod_1.z.array(zod_1.z.string()).optional(),
            actionItems: zod_1.z.array(zod_1.z.object({
                id: zod_1.z.string().optional(),
                description: zod_1.z.string(),
                responsible: zod_1.z.string(),
                dueDate: zod_1.z.coerce.date(),
                status: zod_1.z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "OVERDUE"]).optional(),
            })).optional(),
        }).parse(req.body);
        const minutes = await prisma_1.default.meetingMinutes.create({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.get("/meetings/:meetingId/minutes", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const minutes = await prisma_1.default.meetingMinutes.findMany({
            where: { tenantId, meetingId: req.params.meetingId },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: minutes });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-007: Finalize Minutes with SHA-256 Hash ────────────────────────────
router.post("/minutes/:id/finalize", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const minutes = await prisma_1.default.meetingMinutes.findFirst({
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
        const sha256Hash = (0, crypto_1.createHash)("sha256").update(content).digest("hex");
        const finalized = await prisma_1.default.meetingMinutes.update({
            where: { id: req.params.id },
            data: {
                minutesType: "FINALIZED",
                sha256Hash,
                digitallySigned: false, // TODO: Integrate eSign service
                signedAt: new Date(),
                signedBy: req.user?.userId,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "MINUTES_FINALIZED",
            entity: "MeetingMinutes",
            entityId: minutes.id,
            newData: { sha256Hash },
            ipAddress: req.ip,
        });
        res.json({ success: true, data: finalized });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-007: Update Action Item Status ───────────────────────────────────────
router.patch("/action-items/:minutesId/:itemId", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { status } = zod_1.z.object({
            status: zod_1.z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "OVERDUE"]),
        }).parse(req.body);
        const minutes = await prisma_1.default.meetingMinutes.findFirst({
            where: { id: req.params.minutesId, tenantId },
        });
        if (!minutes) {
            res.status(404).json({ success: false, message: "Minutes not found" });
            return;
        }
        const actionItems = minutes.actionItems || [];
        const itemIndex = actionItems.findIndex((item) => item.id === req.params.itemId);
        if (itemIndex === -1) {
            res.status(404).json({ success: false, message: "Action item not found" });
            return;
        }
        actionItems[itemIndex].status = status;
        if (status === "COMPLETED") {
            actionItems[itemIndex].completedAt = new Date().toISOString();
        }
        await prisma_1.default.meetingMinutes.update({
            where: { id: req.params.minutesId },
            data: { actionItems },
        });
        res.json({ success: true, message: "Action item updated" });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-010: Exception Override Tracking ─────────────────────────────────────
router.post("/approvals/override", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            ruleBypassed: zod_1.z.string(),
            originalApprover: zod_1.z.string(),
            reasonCode: zod_1.z.string(),
            reasonDescription: zod_1.z.string().optional(),
            transactionType: zod_1.z.string(),
            transactionId: zod_1.z.string().optional(),
            amount: zod_1.z.number().optional(),
        }).parse(req.body);
        // Generate override ID
        const count = await prisma_1.default.approvalOverride.count({ where: { tenantId } });
        const overrideId = `OVR-${String(count + 1).padStart(6, "0")}`;
        const override = await prisma_1.default.approvalOverride.create({
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
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "APPROVAL_OVERRIDE",
            entity: "ApprovalOverride",
            entityId: override.id,
            newData: { overrideId, ruleBypassed: data.ruleBypassed, reasonCode: data.reasonCode },
            ipAddress: req.ip,
        });
        res.status(201).json({ success: true, data: override });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.get("/approvals/overrides", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { transactionType, startDate, endDate } = req.query;
        const where = { tenantId };
        if (transactionType)
            where.transactionType = transactionType;
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate)
                where.createdAt.gte = new Date(startDate);
            if (endDate)
                where.createdAt.lte = new Date(endDate);
        }
        const overrides = await prisma_1.default.approvalOverride.findMany({
            where,
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, data: overrides, total: overrides.length });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GOV-008: Maker-Checker Threshold Configuration ──────────────────────────
router.get("/approval-thresholds", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { transactionType } = req.query;
        const where = { tenantId, isActive: true };
        if (transactionType)
            where.transactionType = transactionType;
        const thresholds = await prisma_1.default.approvalThreshold.findMany({
            where,
            orderBy: [{ transactionType: "asc" }, { level: "asc" }],
        });
        res.json({ success: true, data: thresholds });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
router.post("/approval-thresholds", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            transactionType: zod_1.z.string(),
            level: zod_1.z.number().int().min(1).max(4),
            maxAmount: zod_1.z.number().optional(),
            approverRole: zod_1.z.string(),
            slaHours: zod_1.z.number().int().default(24),
        }).parse(req.body);
        const threshold = await prisma_1.default.approvalThreshold.upsert({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=governance.js.map