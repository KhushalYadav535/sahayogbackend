import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// ─── Helper: Generate Product Code ─────────────────────────────────────────
async function generateProductCode(tenantId: string): Promise<string> {
  const count = await prisma.loanProduct.count({ where: { tenantId } });
  return `LN-PROD-${String(count + 1).padStart(3, "0")}`;
}

// ─── POST /api/v1/loans/products ───────────────────────────────────────────
// LN-P01: Create Loan Product (Maker)
router.post("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    const data = z.object({
      productName: z.string().min(1),
      category: z.enum(["PERSONAL", "GOLD", "HOUSING", "AGRICULTURE", "VEHICLE", "EDUCATION", "OTHER"]),
      targetSegment: z.string().optional(),
      description: z.string().optional(),
      interestSchemeId: z.string().optional(),
      eligibilityRulesetId: z.string().optional(),
      documentationChecklistId: z.string().optional(),
      repaymentStructure: z.enum(["STANDARD_EMI", "BULLET", "STEP_UP", "IRREGULAR"]).default("STANDARD_EMI"),
      processingFeeType: z.enum(["FLAT", "PERCENTAGE"]).default("PERCENTAGE"),
      processingFeeValue: z.number().nonnegative(),
      documentationCharge: z.number().nonnegative().default(0),
      insurancePremiumType: z.enum(["FLAT", "PERCENTAGE"]).optional(),
      insurancePremiumValue: z.number().nonnegative().optional(),
      stampDutyPercent: z.number().nonnegative().optional(),
      insuranceSchemeId: z.string().optional(),
    }).parse(req.body);

    // Validate interest scheme exists if provided
    if (data.interestSchemeId) {
      const scheme = await prisma.interestScheme.findFirst({
        where: { id: data.interestSchemeId, tenantId, productType: "Loan" },
      });
      if (!scheme) {
        res.status(400).json({ success: false, message: "Invalid interest scheme" });
        return;
      }
    }

    const productCode = await generateProductCode(tenantId);

    const product = await prisma.loanProduct.create({
      data: {
        tenantId,
        productCode,
        productName: data.productName,
        category: data.category,
        targetSegment: data.targetSegment,
        description: data.description,
        interestSchemeId: data.interestSchemeId,
        eligibilityRulesetId: data.eligibilityRulesetId,
        documentationChecklistId: data.documentationChecklistId,
        repaymentStructure: data.repaymentStructure,
        processingFeeType: data.processingFeeType,
        processingFeeValue: data.processingFeeValue,
        documentationCharge: data.documentationCharge,
        insurancePremiumType: data.insurancePremiumType,
        insurancePremiumValue: data.insurancePremiumValue,
        stampDutyPercent: data.stampDutyPercent,
        insuranceSchemeId: data.insuranceSchemeId,
        status: "DRAFT",
        makerId: userId,
      },
      include: {
        interestScheme: { select: { schemeCode: true, schemeName: true } },
      },
    });

    await createAuditLog(tenantId, userId, "LOAN_PRODUCT_CREATED", {
      productId: product.id,
      productCode: product.productCode,
    });

    res.json({ success: true, product });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/products ────────────────────────────────────────────
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const { status, category, isActive } = req.query;

    const where: any = { tenantId };
    if (status) where.status = status;
    if (category) where.category = category;
    if (isActive !== undefined) where.isActive = isActive === "true";

    const products = await prisma.loanProduct.findMany({
      where,
      include: {
        interestScheme: { select: { schemeCode: true, schemeName: true, status: true } },
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ success: true, products });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/products/:id ────────────────────────────────────────
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const product = await prisma.loanProduct.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        interestScheme: true,
        documentChecklists: true,
        _count: { select: { applications: true } },
      },
    });

    if (!product) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    res.json({ success: true, product });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── PUT /api/v1/loans/products/:id ────────────────────────────────────────
// LN-P04: Update Product (Maker-Checker)
router.put("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    const existing = await prisma.loanProduct.findFirst({
      where: { id: req.params.id, tenantId },
    });

    if (!existing) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    // Only allow updates in DRAFT or DEACTIVATED status
    if (!["DRAFT", "DEACTIVATED"].includes(existing.status)) {
      res.status(400).json({
        success: false,
        message: `Cannot update product in ${existing.status} status. Create a new version instead.`,
      });
      return;
    }

    const data = z.object({
      productName: z.string().min(1).optional(),
      category: z.enum(["PERSONAL", "GOLD", "HOUSING", "AGRICULTURE", "VEHICLE", "EDUCATION", "OTHER"]).optional(),
      targetSegment: z.string().optional(),
      description: z.string().optional(),
      interestSchemeId: z.string().optional(),
      eligibilityRulesetId: z.string().optional(),
      documentationChecklistId: z.string().optional(),
      repaymentStructure: z.enum(["STANDARD_EMI", "BULLET", "STEP_UP", "IRREGULAR"]).optional(),
      processingFeeType: z.enum(["FLAT", "PERCENTAGE"]).optional(),
      processingFeeValue: z.number().nonnegative().optional(),
      documentationCharge: z.number().nonnegative().optional(),
      insurancePremiumType: z.enum(["FLAT", "PERCENTAGE"]).optional(),
      insurancePremiumValue: z.number().nonnegative().optional(),
      stampDutyPercent: z.number().nonnegative().optional(),
      insuranceSchemeId: z.string().optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);

    const updated = await prisma.loanProduct.update({
      where: { id: req.params.id },
      data: {
        ...data,
        makerId: userId,
        status: "DRAFT", // Reset to DRAFT on update
      },
      include: {
        interestScheme: { select: { schemeCode: true, schemeName: true } },
      },
    });

    await createAuditLog(tenantId, userId, "LOAN_PRODUCT_UPDATED", {
      productId: updated.id,
      productCode: updated.productCode,
    });

    res.json({ success: true, product: updated });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── POST /api/v1/loans/products/:id/submit ────────────────────────────────
// LN-P04: Submit for Approval
router.post("/:id/submit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    const product = await prisma.loanProduct.findFirst({
      where: { id: req.params.id, tenantId },
    });

    if (!product) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    if (product.status !== "DRAFT") {
      res.status(400).json({
        success: false,
        message: `Product must be in DRAFT status to submit. Current status: ${product.status}`,
      });
      return;
    }

    const updated = await prisma.loanProduct.update({
      where: { id: req.params.id },
      data: {
        status: "PENDING_APPROVAL",
        submittedAt: new Date(),
        makerId: userId,
      },
    });

    await createAuditLog(tenantId, userId, "LOAN_PRODUCT_SUBMITTED", {
      productId: updated.id,
      productCode: updated.productCode,
    });

    res.json({ success: true, product: updated });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── PUT /api/v1/loans/products/:id/approve ────────────────────────────────
// LN-A03: Approve/Reject Product (Checker)
router.put("/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const checkerId = req.user!.id;

    const data = z.object({
      action: z.enum(["APPROVE", "REJECT"]),
      reasonCode: z.enum([
        "APPROVED_AS_IS",
        "APPROVED_WITH_NOTE",
        "REJECTED_INCORRECT_RATE",
        "REJECTED_INCOMPLETE",
        "REJECTED_POLICY_VIOLATION",
      ]),
      reason: z.string().optional(),
    }).parse(req.body);

    const product = await prisma.loanProduct.findFirst({
      where: { id: req.params.id, tenantId, status: "PENDING_APPROVAL" },
    });

    if (!product) {
      res.status(404).json({ success: false, message: "Product not found or not pending approval" });
      return;
    }

    let updated;
    if (data.action === "APPROVE") {
      // If there's an active version, supersede it
      const activeVersion = await prisma.loanProduct.findFirst({
        where: {
          tenantId,
          productCode: product.productCode,
          status: "ACTIVE",
        },
      });

      if (activeVersion && activeVersion.id !== product.id) {
        await prisma.loanProduct.update({
          where: { id: activeVersion.id },
          data: { status: "SUPERSEDED" },
        });
      }

      updated = await prisma.loanProduct.update({
        where: { id: req.params.id },
        data: {
          status: "ACTIVE",
          checkerId,
          approvedAt: new Date(),
          previousVersionId: activeVersion?.id,
          version: activeVersion ? activeVersion.version + 1 : 1,
        },
      });
    } else {
      updated = await prisma.loanProduct.update({
        where: { id: req.params.id },
        data: {
          status: "DRAFT",
          checkerId,
          rejectedAt: new Date(),
          rejectionReason: data.reason || data.reasonCode,
        },
      });
    }

    await createAuditLog(tenantId, checkerId, `LOAN_PRODUCT_${data.action}D`, {
      productId: updated.id,
      productCode: updated.productCode,
      reasonCode: data.reasonCode,
      reason: data.reason,
    });

    res.json({ success: true, product: updated });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/products/:id/versions ────────────────────────────────
// LN-P07: Version History
router.get("/:id/versions", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const product = await prisma.loanProduct.findFirst({
      where: { id: req.params.id, tenantId },
    });

    if (!product) {
      res.status(404).json({ success: false, message: "Product not found" });
      return;
    }

    // Get all versions of this product (by productCode)
    const versions = await prisma.loanProduct.findMany({
      where: {
        tenantId,
        productCode: product.productCode,
      },
      orderBy: { version: "desc" },
      include: {
        interestScheme: { select: { schemeCode: true, schemeName: true } },
      },
    });

    res.json({ success: true, versions });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/products/:id/compare ─────────────────────────────────
// LN-P07: Compare Versions
router.get("/:id/compare", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const { version1, version2 } = z.object({
      version1: z.string(),
      version2: z.string(),
    }).parse(req.query);

    const product1 = await prisma.loanProduct.findFirst({
      where: { id: version1, tenantId },
    });
    const product2 = await prisma.loanProduct.findFirst({
      where: { id: version2, tenantId },
    });

    if (!product1 || !product2) {
      res.status(404).json({ success: false, message: "One or both versions not found" });
      return;
    }

    if (product1.productCode !== product2.productCode) {
      res.status(400).json({ success: false, message: "Cannot compare different products" });
      return;
    }

    // Compare fields
    const changes: any[] = [];
    const fields = [
      "productName", "category", "targetSegment", "description",
      "repaymentStructure", "processingFeeType", "processingFeeValue",
      "documentationCharge", "insurancePremiumType", "insurancePremiumValue",
      "stampDutyPercent",
    ];

    fields.forEach((field) => {
      const val1 = (product1 as any)[field];
      const val2 = (product2 as any)[field];
      if (val1 !== val2) {
        changes.push({
          field,
          oldValue: val1,
          newValue: val2,
        });
      }
    });

    res.json({
      success: true,
      comparison: {
        version1: { id: product1.id, version: product1.version, ...product1 },
        version2: { id: product2.id, version: product2.version, ...product2 },
        changes,
      },
    });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

export default router;
