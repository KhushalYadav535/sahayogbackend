/**
 * MEM-027: Member Photograph Management
 * MEM-028: Member Signature Management
 * BRD v4.0 — Maker-Checker for initial capture
 */

import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import {
    processImage,
    calculateImageHash,
    validateImageDimensions,
    checkSignatureInkCoverage,
    resizePhoto,
    resizeSignature,
} from "../../services/image-processing.service";
import { generateSignedUrl } from "../../services/signed-url.service";

const router = Router();

// Configure multer for memory storage (for hash calculation before saving)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 }, // 500 KB max
    fileFilter: (req, file, cb) => {
        const allowedMimes = ["image/jpeg", "image/png"];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only JPEG and PNG images are allowed"));
        }
    },
});

// ─── MEM-027: Photograph Management ───────────────────────────────────────────────

// GET /api/v1/members/photos/pending — Get pending photo approvals (must be before /:memberId/photo)
router.get("/photos/pending", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;

        const photos = await prisma.memberPhoto.findMany({
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
    } catch (err) {
        console.error("[Pending Photos GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/members/:memberId/photo — Upload/capture photo (Maker)
router.post("/:memberId/photo", authMiddleware, requireTenant, upload.single("photo"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.memberId;
        const makerId = req.user!.id;

        if (!req.file) {
            res.status(400).json({ success: false, message: "Photo file is required" });
            return;
        }

        // Validate member exists
        const member = await prisma.member.findFirst({
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
        const imageHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

        // TODO: Validate resolution (200x200 to 600x600), auto-crop to 300x300
        // TODO: Reject blank/corrupt images

        // Store file (in production, use cloud storage)
        const storageDir = path.join(process.cwd(), "storage", "photos", tenantId);
        await fs.mkdir(storageDir, { recursive: true });
        const fileName = `${memberId}_${Date.now()}.jpg`;
        const filePath = path.join(storageDir, fileName);
        await fs.writeFile(filePath, req.file.buffer);

        const data = z.object({
            purposeCode: z.enum(["ONBOARDING", "RE_CAPTURE", "KYC_RENEWAL"]).default("ONBOARDING"),
            captureMode: z.enum(["UPLOAD", "WEBCAM"]).default("UPLOAD"),
        }).parse({
            purposeCode: req.body.purposeCode || "ONBOARDING",
            captureMode: req.body.captureMode || "UPLOAD",
        });

        // Set previous photos to HISTORICAL
        await prisma.memberPhoto.updateMany({
            where: { memberId, isCurrent: true },
            data: { isCurrent: false, status: "HISTORICAL" },
        });

        const photo = await prisma.memberPhoto.create({
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

        await createAuditLog(tenantId, "MEMBER_PHOTO_CAPTURED", {
            memberId,
            photoId: photo.id,
            makerId,
            purposeCode: data.purposeCode,
        });

        res.status(201).json({ success: true, photo: { id: photo.id, status: photo.status } });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Photo POST]", err);
        res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Server error" });
    }
});

// PUT /api/v1/members/:memberId/photo/:photoId/submit — Submit for approval
router.put("/:memberId/photo/:photoId/submit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const photoId = req.params.photoId;

        const photo = await prisma.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });

        if (!photo || photo.status !== "DRAFT") {
            res.status(404).json({ success: false, message: "Photo not found or not in DRAFT state" });
            return;
        }

        const updated = await prisma.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "PENDING_APPROVAL",
                submittedAt: new Date(),
            },
        });

        // TODO: Send notification to checker

        await createAuditLog(tenantId, "MEMBER_PHOTO_SUBMITTED", {
            photoId,
            memberId: photo.memberId,
        });

        res.json({ success: true, photo: updated });
    } catch (err) {
        console.error("[Member Photo Submit]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/members/photo/:photoId/approve — Approve photo (Checker) - simplified route
router.put("/photo/:photoId/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const photoId = req.params.photoId;

        const photo = await prisma.memberPhoto.findFirst({
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
        await prisma.memberPhoto.updateMany({
            where: {
                memberId: photo.memberId,
                id: { not: photoId },
                isCurrent: true,
            },
            data: { isCurrent: false, status: "HISTORICAL" },
        });

        const updated = await prisma.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "ACTIVE",
                isCurrent: true,
                checkerId,
                approvedAt: new Date(),
                watermarkMetadata,
            },
        });

        await createAuditLog(tenantId, "MEMBER_PHOTO_APPROVED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
        });

        res.json({ success: true, photo: updated });
    } catch (err) {
        console.error("[Member Photo Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/members/photo/:photoId/reject — Reject photo - simplified route
router.put("/photo/:photoId/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const photoId = req.params.photoId;

        const data = z.object({
            rejectionReason: z.string().min(1),
        }).parse(req.body);

        const photo = await prisma.memberPhoto.findFirst({
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

        const updated = await prisma.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "REJECTED",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: data.rejectionReason,
            },
        });

        await createAuditLog(tenantId, "MEMBER_PHOTO_REJECTED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
            rejectionReason: data.rejectionReason,
        });

        res.json({ success: true, photo: updated });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Photo Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/members/:memberId/photo/:photoId/approve — Approve photo (Checker)
router.put("/:memberId/photo/:photoId/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const photoId = req.params.photoId;

        const photo = await prisma.memberPhoto.findFirst({
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
        await prisma.memberPhoto.updateMany({
            where: {
                memberId: photo.memberId,
                id: { not: photoId },
                isCurrent: true,
            },
            data: { isCurrent: false, status: "HISTORICAL" },
        });

        const updated = await prisma.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "ACTIVE",
                isCurrent: true,
                checkerId,
                approvedAt: new Date(),
                watermarkMetadata,
            },
        });

        await createAuditLog(tenantId, "MEMBER_PHOTO_APPROVED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
        });

        res.json({ success: true, photo: updated });
    } catch (err) {
        console.error("[Member Photo Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/members/:memberId/photo/:photoId/reject — Reject photo
router.put("/:memberId/photo/:photoId/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const photoId = req.params.photoId;

        const data = z.object({
            reason: z.enum(["POOR_QUALITY", "WRONG_MEMBER", "CORRUPT_FILE"]),
        }).parse(req.body);

        const photo = await prisma.memberPhoto.findFirst({
            where: { id: photoId, tenantId },
        });

        if (!photo || photo.status !== "PENDING_APPROVAL") {
            res.status(404).json({ success: false, message: "Photo not found or not pending approval" });
            return;
        }

        const updated = await prisma.memberPhoto.update({
            where: { id: photoId },
            data: {
                status: "REJECTED",
                checkerId,
                rejectedAt: new Date(),
                rejectionReason: data.reason,
            },
        });

        await createAuditLog(tenantId, "MEMBER_PHOTO_REJECTED", {
            photoId,
            memberId: photo.memberId,
            checkerId,
            reason: data.reason,
        });

        res.json({ success: true, photo: updated });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Photo Reject]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/members/:memberId/photo — Get current photo (signed URL)
router.get("/:memberId/photo", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.memberId;

        const photo = await prisma.memberPhoto.findFirst({
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
    } catch (err) {
        console.error("[Member Photo GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── MEM-028: Signature Management ───────────────────────────────────────────────

// POST /api/v1/members/:memberId/signature — Upload/capture signature (Maker - Secretary/Society Admin only)
router.post("/:memberId/signature", authMiddleware, requireTenant, upload.single("signature"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const memberId = req.params.memberId;
        const makerId = req.user!.id;
        const userRole = req.user!.role;

        // Only Secretary or Society Admin can capture signatures
        if (!["SECRETARY", "SOCIETY_ADMIN"].includes(userRole || "")) {
            res.status(403).json({ success: false, message: "Only Secretary or Society Admin can capture signatures" });
            return;
        }

        if (!req.file) {
            res.status(400).json({ success: false, message: "Signature file is required" });
            return;
        }

        const member = await prisma.member.findFirst({
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
        const imageHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

        // Store file
        const storageDir = path.join(process.cwd(), "storage", "signatures", tenantId);
        await fs.mkdir(storageDir, { recursive: true });
        const fileName = `${memberId}_${Date.now()}.png`;
        const filePath = path.join(storageDir, fileName);
        await fs.writeFile(filePath, req.file.buffer);

        const data = z.object({
            purposeCode: z.enum(["ONBOARDING", "RE_CAPTURE", "MINOR_TO_MAJOR"]).default("ONBOARDING"),
            captureMode: z.enum(["UPLOAD", "PAD"]).default("UPLOAD"),
            isGuardianSig: z.boolean().default(false),
        }).parse({
            purposeCode: req.body.purposeCode || "ONBOARDING",
            captureMode: req.body.captureMode || "UPLOAD",
            isGuardianSig: member.isMinor || false,
        });

        // Set previous signatures to HISTORICAL
        await prisma.memberSignature.updateMany({
            where: { memberId, isCurrent: true },
            data: { isCurrent: false, status: "HISTORICAL" },
        });

        const signature = await prisma.memberSignature.create({
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

        await createAuditLog(tenantId, "MEMBER_SIGNATURE_CAPTURED", {
            memberId,
            signatureId: signature.id,
            makerId,
            purposeCode: data.purposeCode,
        });

        res.status(201).json({ success: true, signature: { id: signature.id, status: signature.status } });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Member Signature POST]", err);
        res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Server error" });
    }
});

// PUT /api/v1/members/:memberId/signature/:signatureId/approve — Approve signature (Checker)
router.put("/:memberId/signature/:signatureId/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const checkerId = req.user!.id;
        const signatureId = req.params.signatureId;

        const signature = await prisma.memberSignature.findFirst({
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
        await prisma.memberSignature.updateMany({
            where: {
                memberId: signature.memberId,
                id: { not: signatureId },
                isCurrent: true,
            },
            data: { isCurrent: false, status: "HISTORICAL" },
        });

        const updated = await prisma.memberSignature.update({
            where: { id: signatureId },
            data: {
                status: "ACTIVE",
                isCurrent: true,
                checkerId,
                approvedAt: new Date(),
            },
        });

        // TODO: Notify all Accountants (tellers) about signature update

        await createAuditLog(tenantId, "MEMBER_SIGNATURE_APPROVED", {
            signatureId,
            memberId: signature.memberId,
            checkerId,
        });

        res.json({ success: true, signature: updated });
    } catch (err) {
        console.error("[Member Signature Approve]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
