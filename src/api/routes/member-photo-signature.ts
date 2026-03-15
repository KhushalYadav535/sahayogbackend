import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// ─── GET /api/v1/members/:memberId/photo/current ────────────────────────────
// LN-F04: Get Current Member Photo
router.get("/:memberId/photo/current", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const photo = await prisma.memberPhoto.findFirst({
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
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/members/:memberId/signature/current ────────────────────────
// LN-F04: Get Current Member Signature
router.get("/:memberId/signature/current", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const signature = await prisma.memberSignature.findFirst({
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
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

export default router;
