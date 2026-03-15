import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// ─── GET /api/v1/loans/guarantors/:memberId/exposure ────────────────────────
// LN-F05: Get Guarantor Exposure
router.get("/guarantors/:memberId/exposure", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const guarantor = await prisma.member.findFirst({
      where: { id: req.params.memberId, tenantId },
      include: {
        loans: { where: { status: "active" } },
      },
    });

    if (!guarantor) {
      res.status(404).json({ success: false, message: "Guarantor not found" });
      return;
    }

    // Get all loans where this member is a guarantor
    const guaranteedLoans = await prisma.loanApplication.findMany({
      where: {
        tenantId,
        guarantorIds: { has: req.params.memberId },
        status: { notIn: ["REJECTED", "CLOSED"] },
      },
      include: {
        member: { select: { firstName: true, lastName: true, memberNumber: true } },
      },
    });

    const totalExposure = guaranteedLoans.reduce((sum, app) => sum + Number(app.amountRequested), 0);

    // Get max exposure limit from config
    const config = await prisma.systemConfig.findUnique({
      where: { tenantId_key: { tenantId, key: "loan.guarantor.max.exposure.pct" } },
    });
    const maxExposurePct = config?.value ? Number(config.value) : 200; // Default 200%

    const guarantorIncome = guarantor.monthlyIncome ? Number(guarantor.monthlyIncome) * 12 : 0;
    const maxAllowedExposure = guarantorIncome > 0 ? guarantorIncome * (maxExposurePct / 100) : Infinity;

    res.json({
      success: true,
      guarantor: {
        memberId: guarantor.id,
        memberNumber: guarantor.memberNumber,
        name: `${guarantor.firstName} ${guarantor.lastName}`,
        annualIncome: guarantorIncome,
      },
      totalExposure,
      maxAllowedExposure: maxAllowedExposure === Infinity ? null : maxAllowedExposure,
      maxExposurePct,
      currentGuarantees: guaranteedLoans.map((app) => ({
        applicationId: app.id,
        memberName: `${app.member.firstName} ${app.member.lastName}`,
        memberNumber: app.member.memberNumber,
        amount: app.amountRequested,
        status: app.status,
      })),
      exposureUtilization: maxAllowedExposure !== Infinity && maxAllowedExposure > 0
        ? (totalExposure / maxAllowedExposure) * 100
        : null,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

export default router;
