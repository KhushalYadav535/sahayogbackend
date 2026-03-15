"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ─── GET /api/v1/members/:memberId/photo/current ────────────────────────────
// LN-F04: Get Current Member Photo
router.get("/:memberId/photo/current", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const photo = await prisma_1.default.memberPhoto.findFirst({
            where: {
                memberId: req.params.memberId,
                tenantId,
                status: "APPROVED",
            },
            orderBy: { createdAt: "desc" },
        });
        if (!photo) {
            res.status(404).json({ success: false, message: "Photo not found" });
            return;
        }
        res.json({
            success: true,
            photoUrl: photo.fileUrl,
            photo: {
                id: photo.id,
                fileUrl: photo.fileUrl,
                purposeCode: photo.purposeCode,
                captureMode: photo.captureMode,
                approvedAt: photo.approvedAt,
            },
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
// ─── GET /api/v1/members/:memberId/signature/current ────────────────────────
// LN-F04: Get Current Member Signature
router.get("/:memberId/signature/current", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const signature = await prisma_1.default.memberSignature.findFirst({
            where: {
                memberId: req.params.memberId,
                tenantId,
                status: "APPROVED",
            },
            orderBy: { createdAt: "desc" },
        });
        if (!signature) {
            res.status(404).json({ success: false, message: "Signature not found" });
            return;
        }
        res.json({
            success: true,
            signatureUrl: signature.fileUrl,
            signature: {
                id: signature.id,
                fileUrl: signature.fileUrl,
                purposeCode: signature.purposeCode,
                captureMode: signature.captureMode,
                approvedAt: signature.approvedAt,
            },
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
exports.default = router;
//# sourceMappingURL=member-photo-signature.js.map