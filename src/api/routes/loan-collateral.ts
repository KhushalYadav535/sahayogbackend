import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// ─── POST /api/v1/loans/applications/:id/collateral ─────────────────────────
// LN-COL01: Create/Update Collateral
router.post("/applications/:id/collateral", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    const data = z.object({
      collateralType: z.enum(["PROPERTY", "GOLD", "VEHICLE", "FDR", "SHARES", "OTHER"]),
      description: z.string().optional(),
      valuationDate: z.string().transform((s) => new Date(s)),
      valuationAmount: z.number().positive(),
      valuerName: z.string().optional(),
      // Gold-specific (LN-COL02)
      goldPurity: z.string().optional(),
      goldGrossWeight: z.number().positive().optional(),
      goldNetWeight: z.number().positive().optional(),
      goldCertRefNumber: z.string().optional(),
      goldRatePerGram: z.number().positive().optional(),
      // Property-specific (LN-COL03)
      chargeType: z.enum(["EQUITABLE_MORTGAGE", "REGISTERED_MORTGAGE"]).optional(),
      registrationDate: z.string().transform((s) => new Date(s)).optional(),
      subRegistrarOffice: z.string().optional(),
      registrationNumber: z.string().optional(),
    }).parse(req.body);

    const application = await prisma.loanApplication.findFirst({
      where: { id: req.params.id, tenantId },
      include: { product: true },
    });

    if (!application) {
      res.status(404).json({ success: false, message: "Application not found" });
      return;
    }

    // Calculate LTV ratio
    const ltvRatio = (Number(application.amountRequested) / data.valuationAmount) * 100;

    // Validate LTV for gold loans (LN-COL02)
    if (data.collateralType === "GOLD") {
      const config = await prisma.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key: "gold.loan.ltv.ratio" } },
      });
      const maxLTV = config?.value ? Number(config.value) * 100 : 75; // Default 75%
      if (ltvRatio > maxLTV) {
        res.status(400).json({
          success: false,
          message: `LTV ratio (${ltvRatio.toFixed(2)}%) exceeds maximum allowed (${maxLTV}%)`,
          ltvRatio,
          maxLTV,
        });
        return;
      }
    }

    // Validate LTV for property loans
    if (data.collateralType === "PROPERTY") {
      const config = await prisma.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key: "loan.collateral.ltv.property.pct" } },
      });
      const maxLTV = config?.value ? Number(config.value) : 60; // Default 60%
      if (ltvRatio > maxLTV) {
        res.status(400).json({
          success: false,
          message: `LTV ratio (${ltvRatio.toFixed(2)}%) exceeds maximum allowed (${maxLTV}%)`,
          ltvRatio,
          maxLTV,
        });
        return;
      }
    }

    const collateral = await prisma.collateral.upsert({
      where: { applicationId: application.id },
      create: {
        applicationId: application.id,
        collateralType: data.collateralType,
        description: data.description,
        valuationDate: data.valuationDate,
        valuationAmount: data.valuationAmount,
        valuerName: data.valuerName,
        ltvRatio: Number(ltvRatio.toFixed(2)),
        goldPurity: data.goldPurity,
        goldGrossWeight: data.goldGrossWeight,
        goldNetWeight: data.goldNetWeight,
        goldCertRefNumber: data.goldCertRefNumber,
        goldRatePerGram: data.goldRatePerGram,
        chargeType: data.chargeType,
        registrationDate: data.registrationDate,
        subRegistrarOffice: data.subRegistrarOffice,
        registrationNumber: data.registrationNumber,
      },
      update: {
        collateralType: data.collateralType,
        description: data.description,
        valuationDate: data.valuationDate,
        valuationAmount: data.valuationAmount,
        valuerName: data.valuerName,
        ltvRatio: Number(ltvRatio.toFixed(2)),
        goldPurity: data.goldPurity,
        goldGrossWeight: data.goldGrossWeight,
        goldNetWeight: data.goldNetWeight,
        goldCertRefNumber: data.goldCertRefNumber,
        goldRatePerGram: data.goldRatePerGram,
        chargeType: data.chargeType,
        registrationDate: data.registrationDate,
        subRegistrarOffice: data.subRegistrarOffice,
        registrationNumber: data.registrationNumber,
      },
    });

    await createAuditLog(tenantId, userId, "LOAN_COLLATERAL_CREATED", {
      applicationId: application.id,
      collateralType: data.collateralType,
      valuationAmount: data.valuationAmount,
      ltvRatio: collateral.ltvRatio,
    });

    res.json({ success: true, collateral, ltvRatio: collateral.ltvRatio });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── POST /api/v1/loans/collateral/gold/calculate ──────────────────────────
// LN-COL02: Calculate Gold Loan Eligibility
router.post("/collateral/gold/calculate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const data = z.object({
      purity: z.string(), // e.g., "22K", "24K"
      grossWeight: z.number().positive(),
      netWeight: z.number().positive(),
      goldRatePerGram: z.number().positive(),
    }).parse(req.body);

    // Get LTV ratio from config
    const config = await prisma.systemConfig.findUnique({
      where: { tenantId_key: { tenantId, key: "gold.loan.ltv.ratio" } },
    });
    const ltvRatio = config?.value ? Number(config.value) : 0.75; // Default 75%

    // Calculate gold value
    const goldValue = data.netWeight * data.goldRatePerGram;
    const eligibleAmount = goldValue * ltvRatio;
    const maxAllowedAmount = eligibleAmount;

    res.json({
      success: true,
      eligibleAmount: Math.round(eligibleAmount),
      maxAllowedAmount: Math.round(maxAllowedAmount),
      ltvRatio: ltvRatio * 100,
      goldValue: Math.round(goldValue),
      netWeight: data.netWeight,
      goldRatePerGram: data.goldRatePerGram,
    });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/collaterals ──────────────────────────────────────────
// LN-COL04: Collateral Register
router.get("/collaterals", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const { loanId, status } = req.query;

    const where: any = {
      application: { tenantId },
    };
    if (loanId) where.loanId = loanId;

    const collaterals = await prisma.collateral.findMany({
      where,
      include: {
        application: {
          include: {
            member: { select: { firstName: true, lastName: true, memberNumber: true } },
            product: { select: { productName: true, category: true } },
          },
        },
        loan: { select: { loanNumber: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, collaterals });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

export default router;
