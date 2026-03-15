import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// ─── Helper: Get Sanction Authority Matrix ─────────────────────────────────
async function getSanctionAuthorityMatrix(tenantId: string): Promise<Array<{ level: number; maxAmount: number; approverRole: string }>> {
  const config = await prisma.systemConfig.findUnique({
    where: { tenantId_key: { tenantId, key: "loan.sanction.authority.matrix" } },
  });

  if (config?.value) {
    return JSON.parse(config.value);
  }

  // Default matrix
  return [
    { level: 1, maxAmount: 50000, approverRole: "LOAN_OFFICER" },
    { level: 2, maxAmount: 200000, approverRole: "PRESIDENT" },
    { level: 3, maxAmount: 999999999, approverRole: "COMMITTEE" },
  ];
}

// ─── Helper: Determine Sanction Level ─────────────────────────────────────
async function determineSanctionLevel(tenantId: string, amount: number): Promise<number> {
  const matrix = await getSanctionAuthorityMatrix(tenantId);
  for (const level of matrix) {
    if (amount <= level.maxAmount) {
      return level.level;
    }
  }
  return matrix.length; // Highest level
}

// ─── POST /api/v1/loans/applications/:id/generate-can ──────────────────────
// LN-CAN01: Generate Credit Appraisal Note
router.post("/applications/:id/generate-can", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const application = await prisma.loanApplication.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        member: {
          include: {
            loans: { where: { status: { in: ["active", "closed"] } } },
            sbAccounts: { where: { status: "active" } },
            shareLedger: true,
          },
        },
        product: {
          include: { interestScheme: true },
        },
        documentTrackers: true,
        collateral: true,
      },
    });

    if (!application) {
      res.status(404).json({ success: false, message: "Application not found" });
      return;
    }

    // Check if CAN already exists
    const existingCAN = await prisma.creditAppraisalNote.findUnique({
      where: { applicationId: application.id },
    });

    if (existingCAN) {
      res.json({ success: true, can: existingCAN });
      return;
    }

    const member = application.member;
    const shareCount = member.shareLedger.reduce(
      (sum, l) => (l.transactionType === "purchase" ? sum + l.shares : sum - l.shares),
      0
    );
    const activeLoans = member.loans.filter((l) => l.status === "active");
    const totalOutstanding = activeLoans.reduce((sum, l) => sum + Number(l.outstandingPrincipal), 0);
    const sbBalance = member.sbAccounts.reduce((sum, acc) => sum + Number(acc.balance || 0), 0);

    // Member Profile Summary
    const memberProfileSummary = {
      memberId: member.id,
      memberNumber: member.memberNumber,
      name: `${member.firstName} ${member.lastName}`,
      dateOfBirth: member.dateOfBirth,
      address: member.address,
      phone: member.phone,
      email: member.email,
      shareCount,
      membershipMonths: Math.floor((Date.now() - member.joinDate.getTime()) / (30 * 24 * 60 * 60 * 1000)),
      kycStatus: member.kycStatus,
    };

    // Income Analysis
    const incomeAnalysis = {
      monthlyIncome: application.monthlyIncome,
      employmentType: application.employmentType,
      existingLiabilities: application.existingLiabilities,
      sbBalance,
    };

    // Existing Obligations
    const existingObligations = {
      activeLoansCount: activeLoans.length,
      totalOutstanding,
      activeLoans: activeLoans.map((l) => ({
        loanNumber: l.loanNumber,
        outstandingPrincipal: l.outstandingPrincipal,
        monthlyEMI: activeLoans.length > 0 ? Number(l.outstandingPrincipal) / (l.tenureMonths - 0) : 0, // Approximate
      })),
    };

    // Proposed Loan Terms
    const proposedLoanTerms = {
      productName: application.product?.productName,
      requestedAmount: application.amountRequested,
      tenureMonths: application.tenureMonths,
      interestRate: application.product?.interestScheme?.schemeCode || "TBD",
      repaymentStructure: application.product?.repaymentStructure,
    };

    // Document Status Summary
    const documentStatusSummary = {
      total: application.documentTrackers.length,
      mandatory: application.documentTrackers.filter((d) => d.isMandatory).length,
      verified: application.documentTrackers.filter((d) => d.status === "VERIFIED").length,
      pending: application.documentTrackers.filter((d) => d.status === "PENDING").length,
      documents: application.documentTrackers.map((d) => ({
        name: d.documentName,
        category: d.category,
        mandatory: d.isMandatory,
        status: d.status,
      })),
    };

    // LTV Ratio (if collateral exists)
    const ltvRatio = application.collateral
      ? (Number(application.amountRequested) / Number(application.collateral.valuationAmount)) * 100
      : null;

    // Guarantor Details
    const guarantorDetails = application.guarantorIds.length > 0
      ? await Promise.all(
          application.guarantorIds.map(async (gId) => {
            const guarantor = await prisma.member.findFirst({
              where: { id: gId, tenantId },
              include: {
                loans: { where: { status: "active" } },
              },
            });
            if (!guarantor) return null;
            return {
              memberId: guarantor.id,
              memberNumber: guarantor.memberNumber,
              name: `${guarantor.firstName} ${guarantor.lastName}`,
              activeLoans: guarantor.loans.length,
            };
          })
        )
      : [];

    // Determine sanction level
    const sanctionLevel = await determineSanctionLevel(tenantId, Number(application.amountRequested));

    const can = await prisma.creditAppraisalNote.create({
      data: {
        applicationId: application.id,
        tenantId,
        memberProfileSummary: memberProfileSummary as any,
        aiRiskScore: application.riskScore || 50,
        aiRiskExplanation: `Risk category: ${application.riskCategory || "MEDIUM"}`,
        incomeAnalysis: incomeAnalysis as any,
        existingObligations: existingObligations as any,
        proposedLoanTerms: proposedLoanTerms as any,
        ltvRatio: ltvRatio ? Number(ltvRatio.toFixed(2)) : null,
        guarantorDetails: guarantorDetails.filter(Boolean) as any,
        documentStatusSummary: documentStatusSummary as any,
        loanOfficerRecommendation: "RECOMMEND", // Default, can be updated
        sanctionLevel,
        sanctionStatus: "PENDING",
      },
    });

    res.json({ success: true, can });
  } catch (e) {
    console.error("Generate CAN error:", e);
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/applications/:id/can ────────────────────────────────
router.get("/applications/:id/can", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const can = await prisma.creditAppraisalNote.findFirst({
      where: {
        applicationId: req.params.id,
        application: { tenantId },
      },
    });

    if (!can) {
      res.status(404).json({ success: false, message: "CAN not found. Generate it first." });
      return;
    }

    res.json({ success: true, can });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── POST /api/v1/loans/applications/:id/submit-for-sanction ───────────────
// LN-CAN02: Submit for Sanction
router.post("/applications/:id/submit-for-sanction", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    const data = z.object({
      recommendation: z.enum(["RECOMMEND", "HOLD", "REFER_COMMITTEE"]),
    }).parse(req.body);

    const application = await prisma.loanApplication.findFirst({
      where: { id: req.params.id, tenantId },
    });

    if (!application) {
      res.status(404).json({ success: false, message: "Application not found" });
      return;
    }

    // Generate CAN if not exists
    let can = await prisma.creditAppraisalNote.findUnique({
      where: { applicationId: application.id },
    });

    if (!can) {
      // Trigger CAN generation
      const generateRes = await fetch(`${req.protocol}://${req.get("host")}/api/v1/loans/applications/${application.id}/generate-can`, {
        headers: { Authorization: req.headers.authorization || "" },
        method: "POST",
      });
      if (!generateRes.ok) {
        res.status(500).json({ success: false, message: "Failed to generate CAN" });
        return;
      }
      const canData = await generateRes.json();
      can = canData.can;
    }

    // Update CAN with recommendation
    can = await prisma.creditAppraisalNote.update({
      where: { id: can.id },
      data: {
        loanOfficerRecommendation: data.recommendation,
        sanctionStatus: "PENDING",
      },
    });

    // Update application status
    const updatedApp = await prisma.loanApplication.update({
      where: { id: application.id },
      data: {
        status: "PENDING_SANCTION",
        reviewedBy: userId,
        reviewedAt: new Date(),
      },
    });

    await createAuditLog(tenantId, userId, "LOAN_APPLICATION_SUBMITTED_FOR_SANCTION", {
      applicationId: application.id,
      recommendation: data.recommendation,
      sanctionLevel: can.sanctionLevel,
    });

    res.json({ success: true, application: updatedApp, can });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/sanction-authority-matrix ───────────────────────────
// LN-CAN02: Get Authority Matrix
router.get("/sanction-authority-matrix", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const matrix = await getSanctionAuthorityMatrix(tenantId);
    res.json({ success: true, matrix });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── PUT /api/v1/loans/applications/:id/sanction ────────────────────────────
// LN-CAN03, LN-CAN04: Approve/Reject/Escalate Sanction
router.put("/applications/:id/sanction", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;

    const data = z.object({
      action: z.enum(["APPROVE", "REJECT", "ESCALATE"]),
      reasonCode: z.string().optional(),
      reason: z.string().optional(),
      exceptionJustification: z.string().optional(), // For LN-CAN04
    }).parse(req.body);

    const application = await prisma.loanApplication.findFirst({
      where: { id: req.params.id, tenantId },
      include: { creditAppraisalNote: true },
    });

    if (!application) {
      res.status(404).json({ success: false, message: "Application not found" });
      return;
    }

    if (application.status !== "PENDING_SANCTION") {
      res.status(400).json({
        success: false,
        message: `Application must be in PENDING_SANCTION status. Current: ${application.status}`,
      });
      return;
    }

    const can = application.creditAppraisalNote;
    if (!can) {
      res.status(400).json({ success: false, message: "Credit Appraisal Note not found. Generate it first." });
      return;
    }

    let updatedApp;
    let updatedCAN;
    let sanctionLetter = null;

    if (data.action === "APPROVE") {
      // Check for exception authorization (LN-CAN04)
      const exceptionGranted = !!data.exceptionJustification;

      updatedCAN = await prisma.creditAppraisalNote.update({
        where: { id: can.id },
        data: {
          sanctionStatus: "APPROVED",
          approvedBy: userId,
          approvedAt: new Date(),
          exceptionGranted,
          exceptionJustification: data.exceptionJustification,
          exceptionAuthorizedBy: exceptionGranted ? userId : null,
        },
      });

      updatedApp = await prisma.loanApplication.update({
        where: { id: application.id },
        data: {
          status: "SANCTIONED",
          reviewedBy: userId,
          reviewedAt: new Date(),
        },
      });

      // Generate sanction letter (LN-CAN05)
      // Calculate EMI schedule summary
      const { generateEMISchedule } = await import("../../services/emi-schedule.service");
      const emiSchedule = await generateEMISchedule(
        tenantId,
        Number(application.amountRequested),
        application.product?.interestScheme?.schemeCode ? 12 : 12, // Default rate, should come from scheme
        application.tenureMonths,
        new Date(),
        0
      );
      const totalInterestOutgo = emiSchedule.reduce((sum, e) => sum + Number(e.interestComponent), 0);

      sanctionLetter = await prisma.loanSanctionLetter.create({
        data: {
          applicationId: application.id,
          sanctionedAmount: application.amountRequested,
          approvedTenure: application.tenureMonths,
          emiScheduleSummary: {
            totalInstallments: emiSchedule.length,
            firstEmiDate: emiSchedule[0]?.dueDate,
            emiAmount: emiSchedule[0]?.totalEmi,
          },
          totalInterestOutgo,
          securityDetails: application.collateral ? {
            type: application.collateral.collateralType,
            valuation: application.collateral.valuationAmount,
          } : null,
        },
      });

      await createAuditLog(tenantId, userId, "LOAN_SANCTION_APPROVED", {
        applicationId: application.id,
        exceptionGranted,
      });
    } else if (data.action === "REJECT") {
      updatedCAN = await prisma.creditAppraisalNote.update({
        where: { id: can.id },
        data: {
          sanctionStatus: "REJECTED",
          rejectedBy: userId,
          rejectedAt: new Date(),
          rejectionReasonCode: data.reasonCode,
          rejectionReason: data.reason,
        },
      });

      updatedApp = await prisma.loanApplication.update({
        where: { id: application.id },
        data: {
          status: "REJECTED",
          reviewedBy: userId,
          reviewedAt: new Date(),
          remarks: data.reason,
        },
      });

      await createAuditLog(tenantId, userId, "LOAN_SANCTION_REJECTED", {
        applicationId: application.id,
        reasonCode: data.reasonCode,
        reason: data.reason,
      });
    } else if (data.action === "ESCALATE") {
      const nextLevel = can.sanctionLevel + 1;
      updatedCAN = await prisma.creditAppraisalNote.update({
        where: { id: can.id },
        data: {
          sanctionLevel: nextLevel,
          escalatedTo: userId,
          escalatedAt: new Date(),
          sanctionStatus: "PENDING",
        },
      });

      await createAuditLog(tenantId, userId, "LOAN_SANCTION_ESCALATED", {
        applicationId: application.id,
        fromLevel: can.sanctionLevel,
        toLevel: nextLevel,
      });
    }

    res.json({
      success: true,
      application: updatedApp,
      can: updatedCAN,
      sanctionLetter,
    });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── GET /api/v1/loans/applications/:id/sanction-letter/pdf ─────────────────
// LN-CAN05: Download Sanction Letter PDF
router.get("/applications/:id/sanction-letter/pdf", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const application = await prisma.loanApplication.findFirst({
      where: { id: req.params.id, tenantId },
      include: {
        member: true,
        sanctionLetter: true,
        product: true,
      },
    });

    if (!application || !application.sanctionLetter) {
      res.status(404).json({ success: false, message: "Sanction letter not found" });
      return;
    }

    // Generate PDF content (simplified - in production, use a PDF library like pdfkit or puppeteer)
    const letter = application.sanctionLetter;
    const pdfContent = {
      loanNumber: application.id.slice(-8),
      memberName: `${application.member.firstName} ${application.member.lastName}`,
      memberNumber: application.member.memberNumber,
      sanctionedAmount: Number(letter.sanctionedAmount),
      approvedTenure: letter.approvedTenure,
      emiAmount: letter.emiScheduleSummary?.emiAmount,
      firstEmiDate: letter.emiScheduleSummary?.firstEmiDate,
      totalInterestOutgo: Number(letter.totalInterestOutgo),
      securityDetails: letter.securityDetails,
      generatedAt: new Date().toISOString(),
    };

    // Return JSON for now - frontend will generate PDF using browser APIs
    res.json({
      success: true,
      pdfData: pdfContent,
      message: "PDF data generated. Use browser print API or PDF library to generate actual PDF.",
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

// ─── POST /api/v1/loans/applications/:id/acknowledge-sanction ──────────────
// LN-CAN05: Member Acknowledgement
router.post("/applications/:id/acknowledge-sanction", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const data = z.object({
      signatureUrl: z.string().optional(),
    }).parse(req.body);

    const application = await prisma.loanApplication.findFirst({
      where: { id: req.params.id, tenantId },
      include: { sanctionLetter: true },
    });

    if (!application) {
      res.status(404).json({ success: false, message: "Application not found" });
      return;
    }

    if (application.status !== "SANCTIONED") {
      res.status(400).json({
        success: false,
        message: `Application must be in SANCTIONED status. Current: ${application.status}`,
      });
      return;
    }

    if (!application.sanctionLetter) {
      res.status(400).json({ success: false, message: "Sanction letter not found" });
      return;
    }

    await prisma.loanSanctionLetter.update({
      where: { id: application.sanctionLetter.id },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedBy: application.memberId,
        signatureUrl: data.signatureUrl,
      },
    });

    const updatedApp = await prisma.loanApplication.update({
      where: { id: application.id },
      data: {
        status: "SANCTION_ACKNOWLEDGED",
      },
    });

    res.json({ success: true, application: updatedApp });
  } catch (e: any) {
    if (e.name === "ZodError") {
      res.status(400).json({ success: false, errors: e.errors });
      return;
    }
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

export default router;
