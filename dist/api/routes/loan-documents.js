"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const router = (0, express_1.Router)();
// Configure multer for file uploads
const upload = (0, multer_1.default)({
    dest: "uploads/loan-documents/",
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (_req, file, cb) => {
        const allowedTypes = [".pdf", ".jpg", ".jpeg", ".png"];
        const ext = path_1.default.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(ext)) {
            cb(null, true);
        }
        else {
            cb(new Error("Invalid file type. Only PDF, JPG, PNG allowed."));
        }
    },
});
// ─── GET /api/v1/loans/products/:productId/checklist ────────────────────────
// LN-DC01: Get Document Checklist for Product
router.get("/products/:productId/checklist", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { productId } = req.params;
        const product = await prisma_1.default.loanProduct.findFirst({
            where: { id: productId, tenantId },
        });
        if (!product) {
            res.status(404).json({ success: false, message: "Product not found" });
            return;
        }
        // Get product-specific checklist
        const checklist = await prisma_1.default.loanDocumentChecklist.findMany({
            where: {
                tenantId,
                OR: [
                    { productId },
                    { productId: null }, // Global checklist items
                ],
            },
            orderBy: { createdAt: "asc" },
        });
        res.json({ success: true, checklist });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── POST /api/v1/loans/products/:productId/checklist ───────────────────────
// LN-DC01: Create Document Checklist Item
router.post("/products/:productId/checklist", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { productId } = req.params;
        const data = zod_1.z.object({
            documentName: zod_1.z.string().min(1),
            category: zod_1.z.enum([
                "INCOME_PROOF",
                "IDENTITY",
                "ADDRESS",
                "PROPERTY",
                "GUARANTOR",
                "COLLATERAL",
                "INSURANCE",
                "OTHER",
            ]),
            isMandatory: zod_1.z.boolean().default(false),
            applicableCategories: zod_1.z.array(zod_1.z.string()).default([]),
        }).parse(req.body);
        const product = await prisma_1.default.loanProduct.findFirst({
            where: { id: productId, tenantId },
        });
        if (!product) {
            res.status(404).json({ success: false, message: "Product not found" });
            return;
        }
        const checklistItem = await prisma_1.default.loanDocumentChecklist.create({
            data: {
                tenantId,
                productId,
                documentName: data.documentName,
                category: data.category,
                isMandatory: data.isMandatory,
                applicableCategories: data.applicableCategories,
            },
        });
        res.json({ success: true, checklist: checklistItem });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── GET /api/v1/loans/applications/:id/documents ───────────────────────────
// LN-DC02: Get Document Tracker for Application
router.get("/applications/:id/documents", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const application = await prisma_1.default.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
            include: { product: true },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }
        // Get checklist for the product
        const checklist = await prisma_1.default.loanDocumentChecklist.findMany({
            where: {
                tenantId,
                OR: [
                    { productId: application.productId },
                    { productId: null },
                ],
            },
        });
        // Get or create document trackers
        const trackers = await Promise.all(checklist.map(async (item) => {
            let tracker = await prisma_1.default.loanDocumentTracker.findUnique({
                where: {
                    applicationId_checklistId: {
                        applicationId: application.id,
                        checklistId: item.id,
                    },
                },
            });
            if (!tracker) {
                tracker = await prisma_1.default.loanDocumentTracker.create({
                    data: {
                        applicationId: application.id,
                        checklistId: item.id,
                        documentName: item.documentName,
                        category: item.category,
                        isMandatory: item.isMandatory,
                        status: "PENDING",
                    },
                });
            }
            return tracker;
        }));
        const mandatoryCount = trackers.filter((t) => t.isMandatory).length;
        const verifiedMandatory = trackers.filter((t) => t.isMandatory && t.status === "VERIFIED").length;
        const readiness = mandatoryCount > 0 ? (verifiedMandatory / mandatoryCount) * 100 : 100;
        res.json({
            success: true,
            documents: trackers,
            readiness: {
                verified: verifiedMandatory,
                mandatory: mandatoryCount,
                total: trackers.length,
                percentage: readiness,
                ready: verifiedMandatory === mandatoryCount,
            },
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── POST /api/v1/loans/applications/:id/documents ─────────────────────────
// LN-DC02: Upload Document
router.post("/applications/:id/documents", auth_1.authMiddleware, auth_1.requireTenant, upload.single("file"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.id;
        const { checklistId } = zod_1.z.object({
            checklistId: zod_1.z.string(),
        }).parse(req.body);
        if (!req.file) {
            res.status(400).json({ success: false, message: "File is required" });
            return;
        }
        const application = await prisma_1.default.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }
        const checklist = await prisma_1.default.loanDocumentChecklist.findFirst({
            where: { id: checklistId, tenantId },
        });
        if (!checklist) {
            res.status(404).json({ success: false, message: "Checklist item not found" });
            return;
        }
        // Generate file URL (in production, upload to cloud storage)
        const fileUrl = `/uploads/loan-documents/${req.file.filename}`;
        const tracker = await prisma_1.default.loanDocumentTracker.upsert({
            where: {
                applicationId_checklistId: {
                    applicationId: application.id,
                    checklistId: checklist.id,
                },
            },
            create: {
                applicationId: application.id,
                checklistId: checklist.id,
                documentName: checklist.documentName,
                category: checklist.category,
                isMandatory: checklist.isMandatory,
                status: "SUBMITTED",
                fileUrl,
                uploadedAt: new Date(),
                uploadedBy: userId,
            },
            update: {
                status: "SUBMITTED",
                fileUrl,
                uploadedAt: new Date(),
                uploadedBy: userId,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, userId, "LOAN_DOCUMENT_UPLOADED", {
            applicationId: application.id,
            documentName: checklist.documentName,
            trackerId: tracker.id,
        });
        res.json({ success: true, document: tracker });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── PUT /api/v1/loans/applications/:id/documents/:docId/status ─────────────
// LN-DC02, LN-DC04: Update Document Status (Verify/Reject)
router.put("/applications/:id/documents/:docId/status", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const userId = req.user.id;
        const data = zod_1.z.object({
            status: zod_1.z.enum(["VERIFIED", "REJECTED", "UNDER_REVIEW"]),
            reason: zod_1.z.string().optional(),
        }).parse(req.body);
        const tracker = await prisma_1.default.loanDocumentTracker.findFirst({
            where: {
                id: req.params.docId,
                application: { id: req.params.id, tenantId },
            },
        });
        if (!tracker) {
            res.status(404).json({ success: false, message: "Document tracker not found" });
            return;
        }
        const updateData = {
            status: data.status,
        };
        if (data.status === "VERIFIED") {
            updateData.verifiedAt = new Date();
            updateData.verifiedBy = userId;
        }
        else if (data.status === "REJECTED") {
            updateData.rejectedAt = new Date();
            updateData.rejectedBy = userId;
            updateData.rejectionReason = data.reason || "Rejected";
        }
        const updated = await prisma_1.default.loanDocumentTracker.update({
            where: { id: tracker.id },
            data: updateData,
        });
        await (0, audit_1.createAuditLog)(tenantId, userId, `LOAN_DOCUMENT_${data.status}`, {
            applicationId: req.params.id,
            documentName: tracker.documentName,
            trackerId: tracker.id,
            reason: data.reason,
        });
        res.json({ success: true, document: updated });
    }
    catch (e) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── GET /api/v1/loans/applications/:id/documents/readiness ────────────────
// LN-DC03: Check Document Readiness (Disbursement Gate)
router.get("/applications/:id/documents/readiness", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const application = await prisma_1.default.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }
        const trackers = await prisma_1.default.loanDocumentTracker.findMany({
            where: { applicationId: application.id },
        });
        const mandatoryTrackers = trackers.filter((t) => t.isMandatory);
        const verifiedMandatory = mandatoryTrackers.filter((t) => t.status === "VERIFIED").length;
        const totalMandatory = mandatoryTrackers.length;
        const ready = totalMandatory > 0 && verifiedMandatory === totalMandatory;
        const blockingDocuments = mandatoryTrackers
            .filter((t) => t.status !== "VERIFIED")
            .map((t) => ({
            documentName: t.documentName,
            status: t.status,
            category: t.category,
        }));
        res.json({
            success: true,
            ready,
            verifiedCount: verifiedMandatory,
            mandatoryCount: totalMandatory,
            totalDocuments: trackers.length,
            percentage: totalMandatory > 0 ? (verifiedMandatory / totalMandatory) * 100 : 100,
            blockingDocuments,
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
exports.default = router;
//# sourceMappingURL=loan-documents.js.map