"use strict";
/**
 * MEM-027: Member Photograph Management
 * MEM-028: Member Signature Management
 * BRD v4.0 — Maker-Checker for initial capture
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const crypto_1 = __importDefault(require("crypto"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const router = (0, express_1.Router)();
// Configure multer for memory storage (for hash calculation before saving)
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 500 * 1024 }, // 500 KB max
    fileFilter: (req, file, cb) => {
        const allowedMimes = ["image/jpeg", "image/png"];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new Error("Only JPEG and PNG images are allowed"));
        }
    },
});
// ─── MEM-027: Photograph Management ───────────────────────────────────────────────
// GET /api/v1/members/photos/pending — Get pending photo approvals (must be before /:memberId/photo)
router.get("/photos/pending", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const photos = await prisma_1.default.memberPhoto.findMany({
            where: {
                tenantId,
                status: "PENDING_APPROVAL",
            },
            include: {
                member: {
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        memberNumber: true,
                    },
                },
            },
            orderBy: { submittedAt: "asc" },
        });
        // Format response with member details and image URLs
        const formattedPhotos = photos.map((photo) => ({
            id: photo.id,
            memberId: photo.memberId,
            memberName: `${photo.member.firstName || ""} ${photo.member.lastName || ""}`.trim() || "",
            memberNumber: photo.member.memberNumber || "",
            purposeCode: photo.purposeCode,
            captureMode: photo.captureMode,
            status: photo.status,
            submittedAt: photo.submittedAt?.toISOString(),
            makerId: photo.makerId,
            createdAt: photo.createdAt.toISOString(),
            // Generate temporary file URL (in production, use signed URLs)
            imageUrl: `/api/v1/members/${photo.memberId}/photo/${photo.id}/file`,
        }));
        res.json({ success: true, photos: formattedPhotos });
    }
    catch (err) {
        console.error("[Pending Photos GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/members/:memberId/photo — Upload/capture photo (Maker)
router.post("/:memberId/photo", auth_1.authMiddleware, auth_1.requireTenant, upload.single("photo"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.memberId;
        const makerId = req.user.id;
        if (!req.file) {
            res.status(400).json({ success: false, message: "Photo file is required" });
            return;
        }
        // Validate member exists
        const member = await prisma_1.default.member.findFirst({
            where: { id: memberId, tenantId },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Validate file size (200 KB default, configurable)
        const maxSize = 200 * 1024; // TODO: Read from system_config
        if (req.file.size > maxSize) {
            res.status(400).json({ success: false, message: `File size exceeds ${maxSize / 1024} KB limit` });
            return;
        }
        // Calculate SHA-256 hash
        const imageHash = crypto_1.default.createHash("sha256").update(req.file.buffer).digest("hex");
        // TODO: Validate resolution (200x200 to 600x600), auto-crop to 300x300
        // TODO: Reject blank/corrupt images
        // Store file (in production, use cloud storage)
        const storageDir = path_1.default.join(process.cwd(), "storage", "photos", tenantId);
        await promises_1.default.mkdir(storageDir, { recursive: true });
        const fileName = `${memberId}_${Date.now()}.jpg`;
        const filePath = path_1.default.join(storageDir, fileName);
        await promises_1.default.writeFile(filePath, req.file.buffer);
        const data = zod_1.z.object({
            purposeCode: zod_1.z.enum(["ONBOARDING", "RE_CAPTURE", "KYC_RENEWAL"]).default("ONBOARDING"),
            captureMode: zod_1.z.enum(["UPLOAD", "WEBCAM"]).default("UPLOAD"),
        }).parse({
            purposeCode: req.body.purposeCode || "ONBOARDING",
            captureMode: req.body.captureMode || "UPLOAD",
        });
        // Set previous photos to HISTORICAL
        await prisma_1.default.memberPhoto.updateMany({
            where: { memberId, isCurrent: true },
            data: { isCurrent: false, status: "HISTORICAL" },
        });
        const photo = await prisma_1.default.memberPhoto.create({
            data: {
                memberId,
                tenantId,
                purposeCode: data.purposeCode,
                captureMode: data.captureMode,
                filePath,
                imageHash,
                status: "DRAFT",
                makerId,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_PHOTO_CAPTURED", {
            memberId,
            photoId: photo.id,
            makerId,
            purposeCode: data.purposeCode,
        });
        res.status(201).json({ success: true, photo: { id: photo.id, status: photo.status } });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Photo POST]", err);
        res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Server error" });
    }
});
// PUT /api/v1/members/:memberId/photo/:photoId/submit — Submit for approval
router.put("/:memberId/photo/:photoId/submit", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const photoId = req.params.photoId;
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });
        if (!photo || photo.status !== "DRAFT") {
            res.status(404).json({ success: false, message: "Photo not found or not in DRAFT state" });
            return;
        }
        const updated = await prisma_1.default.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "PENDING_APPROVAL",
                submittedAt: new Date(),
            },
        });
        // TODO: Send notification to checker
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_PHOTO_SUBMITTED", {
            photoId,
            memberId: photo.memberId,
        });
        res.json({ success: true, photo: updated });
    }
    catch (err) {
        console.error("[Member Photo Submit]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/members/photo/:photoId/approve — Approve photo (Checker) - simplified route
router.put("/photo/:photoId/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const photoId = req.params.photoId;
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });
        if (!photo || photo.status !== "PENDING_APPROVAL") {
            res.status(404).json({ success: false, message: "Photo not found or not pending approval" });
            return;
        }
        // Check maker != checker
        if (photo.makerId === checkerId) {
            res.status(400).json({ success: false, message: "Checker must be different from Maker" });
            return;
        }
        // TODO: Embed watermark (member_id + tenant_id + timestamp)
        const watermarkMetadata = JSON.stringify({
            memberId: photo.memberId,
            tenantId,
            timestamp: new Date().toISOString(),
        });
        // Set previous photos to HISTORICAL
        await prisma_1.default.memberPhoto.updateMany({
            where: {
                memberId: photo.memberId,
                id: { not: photoId },
                isCurrent: true,
            },
            data: { isCurrent: false, status: "HISTORICAL" },
        });
        const updated = await prisma_1.default.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "ACTIVE",
                isCurrent: true,
                checkerId,
                approvedAt: new Date(),
                watermarkMetadata,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_PHOTO_APPROVED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
        });
        res.json({ success: true, photo: updated });
    }
    catch (err) {
        console.error("[Member Photo Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/members/photo/:photoId/reject — Reject photo - simplified route
router.put("/photo/:photoId/reject", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const photoId = req.params.photoId;
        const data = zod_1.z.object({
            rejectionReason: zod_1.z.string().min(1),
        }).parse(req.body);
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });
        if (!photo || photo.status !== "PENDING_APPROVAL") {
            res.status(404).json({ success: false, message: "Photo not found or not pending approval" });
            return;
        }
        // Check maker != checker
        if (photo.makerId === checkerId) {
            res.status(400).json({ success: false, message: "Checker must be different from Maker" });
            return;
        }
        const updated = await prisma_1.default.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "REJECTED",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: data.rejectionReason,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_PHOTO_REJECTED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
            rejectionReason: data.rejectionReason,
        });
        res.json({ success: true, photo: updated });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Photo Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/members/:memberId/photo/:photoId/approve — Approve photo (Checker)
router.put("/:memberId/photo/:photoId/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const photoId = req.params.photoId;
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });
        if (!photo || photo.status !== "PENDING_APPROVAL") {
            res.status(404).json({ success: false, message: "Photo not found or not pending approval" });
            return;
        }
        // Check maker != checker
        if (photo.makerId === checkerId) {
            res.status(400).json({ success: false, message: "Checker must be different from Maker" });
            return;
        }
        // TODO: Embed watermark (member_id + tenant_id + timestamp)
        const watermarkMetadata = JSON.stringify({
            memberId: photo.memberId,
            tenantId,
            timestamp: new Date().toISOString(),
        });
        // Set previous photos to HISTORICAL
        await prisma_1.default.memberPhoto.updateMany({
            where: {
                memberId: photo.memberId,
                id: { not: photoId },
                isCurrent: true,
            },
            data: { isCurrent: false, status: "HISTORICAL" },
        });
        const updated = await prisma_1.default.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "ACTIVE",
                isCurrent: true,
                checkerId,
                approvedAt: new Date(),
                watermarkMetadata,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_PHOTO_APPROVED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
        });
        res.json({ success: true, photo: updated });
    }
    catch (err) {
        console.error("[Member Photo Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/members/:memberId/photo/:photoId/reject — Reject photo
router.put("/:memberId/photo/:photoId/reject", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const photoId = req.params.photoId;
        const data = zod_1.z.object({
            reason: zod_1.z.enum(["POOR_QUALITY", "WRONG_MEMBER", "CORRUPT_FILE"]),
        }).parse(req.body);
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });
        if (!photo || photo.status !== "PENDING_APPROVAL") {
            res.status(404).json({ success: false, message: "Photo not found or not pending approval" });
            return;
        }
        const updated = await prisma_1.default.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "REJECTED",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: data.reason,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_PHOTO_REJECTED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
            reason: data.reason,
        });
        res.json({ success: true, photo: updated });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Photo Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/members/:memberId/photo — Get current photo (signed URL)
router.get("/:memberId/photo", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.memberId;
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: {
                memberId,
                tenantId,
                isCurrent: true,
                status: "ACTIVE",
            },
        });
        if (!photo) {
            res.status(404).json({ success: false, message: "No active photo found" });
            return;
        }
        // TODO: Generate signed URL with expiry (15 minutes default)
        // For now, return file path (in production, use cloud storage signed URLs)
        res.json({
            success: true,
            photo: {
                id: photo.id,
                url: `/api/v1/members/${memberId}/photo/${photo.id}/file`, // Temporary
                expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            },
        });
    }
    catch (err) {
        console.error("[Member Photo GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── MEM-028: Signature Management ───────────────────────────────────────────────
// POST /api/v1/members/:memberId/signature — Upload/capture signature (Maker - Secretary/Society Admin only)
router.post("/:memberId/signature", auth_1.authMiddleware, auth_1.requireTenant, upload.single("signature"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const memberId = req.params.memberId;
        const makerId = req.user.id;
        const userRole = req.user.role;
        // Only Secretary or Society Admin can capture signatures
        if (!["SECRETARY", "SOCIETY_ADMIN"].includes(userRole || "")) {
            res.status(403).json({ success: false, message: "Only Secretary or Society Admin can capture signatures" });
            return;
        }
        if (!req.file) {
            res.status(400).json({ success: false, message: "Signature file is required" });
            return;
        }
        const member = await prisma_1.default.member.findFirst({
            where: { id: memberId, tenantId },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        // Validate file size (100 KB default)
        const maxSize = 100 * 1024; // TODO: Read from system_config
        if (req.file.size > maxSize) {
            res.status(400).json({ success: false, message: `File size exceeds ${maxSize / 1024} KB limit` });
            return;
        }
        // TODO: Validate ink coverage >= 5% (member.signature.blank.reject.threshold.pct)
        // TODO: Normalize to 400x150 px greyscale
        // Calculate SHA-256 hash
        const imageHash = crypto_1.default.createHash("sha256").update(req.file.buffer).digest("hex");
        // Store file
        const storageDir = path_1.default.join(process.cwd(), "storage", "signatures", tenantId);
        await promises_1.default.mkdir(storageDir, { recursive: true });
        const fileName = `${memberId}_${Date.now()}.png`;
        const filePath = path_1.default.join(storageDir, fileName);
        await promises_1.default.writeFile(filePath, req.file.buffer);
        const data = zod_1.z.object({
            purposeCode: zod_1.z.enum(["ONBOARDING", "RE_CAPTURE", "MINOR_TO_MAJOR"]).default("ONBOARDING"),
            captureMode: zod_1.z.enum(["UPLOAD", "PAD"]).default("UPLOAD"),
            isGuardianSig: zod_1.z.boolean().default(false),
        }).parse({
            purposeCode: req.body.purposeCode || "ONBOARDING",
            captureMode: req.body.captureMode || "UPLOAD",
            isGuardianSig: member.isMinor || false,
        });
        // Set previous signatures to HISTORICAL
        await prisma_1.default.memberSignature.updateMany({
            where: { memberId, isCurrent: true },
            data: { isCurrent: false, status: "HISTORICAL" },
        });
        const signature = await prisma_1.default.memberSignature.create({
            data: {
                memberId,
                tenantId,
                purposeCode: data.purposeCode,
                captureMode: data.captureMode,
                filePath,
                imageHash,
                isGuardianSig: data.isGuardianSig,
                guardianValidUntil: member.isMinor && member.dateOfBirth ? new Date(new Date(member.dateOfBirth).getTime() + 18 * 365.25 * 24 * 60 * 60 * 1000) : null,
                status: "DRAFT",
                makerId,
            },
        });
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_SIGNATURE_CAPTURED", {
            memberId,
            signatureId: signature.id,
            makerId,
            purposeCode: data.purposeCode,
        });
        res.status(201).json({ success: true, signature: { id: signature.id, status: signature.status } });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Signature POST]", err);
        res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Server error" });
    }
});
// PUT /api/v1/members/:memberId/signature/:signatureId/approve — Approve signature (Checker)
router.put("/:memberId/signature/:signatureId/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const checkerId = req.user.id;
        const signatureId = req.params.signatureId;
        const signature = await prisma_1.default.memberSignature.findFirst({
            where: { id: signatureId, tenantId },
        });
        if (!signature || signature.status !== "PENDING_APPROVAL") {
            res.status(404).json({ success: false, message: "Signature not found or not pending approval" });
            return;
        }
        if (signature.makerId === checkerId) {
            res.status(400).json({ success: false, message: "Checker must be different from Maker" });
            return;
        }
        // Set previous signatures to HISTORICAL
        await prisma_1.default.memberSignature.updateMany({
            where: {
                memberId: signature.memberId,
                id: { not: signatureId },
                isCurrent: true,
            },
            data: { isCurrent: false, status: "HISTORICAL" },
        });
        const updated = await prisma_1.default.memberSignature.update({
            where: { id: signatureId },
            data: {
                status: "ACTIVE",
                isCurrent: true,
                checkerId,
                approvedAt: new Date(),
            },
        });
        // TODO: Notify all Accountants (tellers) about signature update
        await (0, audit_1.createAuditLog)(tenantId, "MEMBER_SIGNATURE_APPROVED", {
            signatureId,
            memberId: signature.memberId,
            checkerId,
        });
        res.json({ success: true, signature: updated });
    }
    catch (err) {
        console.error("[Member Signature Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=member-documents.js.map