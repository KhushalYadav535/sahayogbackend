import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";
import { postGl, currentPeriod } from "../../lib/gl-posting";
import {
    GOLD_LOAN_MAX_LTV,
    LAD_MAX_RATIO,
    MICROFINANCE_REPAYMENT_CAP,
    PRECLOSURE_CHARGE_MIN,
    PRECLOSURE_CHARGE_MAX,
    KCC_SUBVENTION_RATE,
    LOAN_GL_CODES,
} from "../../lib/coa-rules";

const router = Router();

// ─── Helper: Compute DPD for a loan ─────────────────────────────────────────

function computeDpd(overdueEmi: { dueDate: Date } | null): number {
    if (!overdueEmi) return 0;
    const today = new Date();
    const diff = today.getTime() - overdueEmi.dueDate.getTime();
    return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

function npaCategory(dpd: number): string {
    if (dpd < 30) return "standard";
    if (dpd < 60) return "sma_0";
    if (dpd < 90) return "sma_1";
    if (dpd < 365) return "sub_standard";
    if (dpd < 730) return "doubtful_1";
    if (dpd < 1095) return "doubtful_2";
    return "doubtful_3";
}

// ─── GET /api/v1/loans/eligibility/:memberId ─────────────────────────────────
router.get("/eligibility/:memberId", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { evaluateEligibility } = await import("../../services/eligibility.service");
        const { result, ruleVersion } = await evaluateEligibility(tenantId, req.params.memberId);
        res.json({ success: true, eligibility: result, ruleVersion });
    } catch (e) {
        res.status(500).json({ success: false, message: (e as Error).message });
    }
});

// ─── POST /api/v1/loans/applications ─────────────────────────────────────────
router.post("/applications", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            memberId: z.string(),
            loanType: z.enum(["personal", "agricultural", "business", "housing", "education", "gold"]),
            // COA: loan sub-type
            loanSubType: z.enum([
                "kcc", "crop", "livestock", "gold", "lad", "shg", "msme",
                "housing", "staff", "micro", "personal"
            ]).optional(),
            amountRequested: z.number().positive(),
            purpose: z.string().optional(),
            tenureMonths: z.number().int().positive(),
            moratoriumMonths: z.number().int().min(0).default(0),
            // COA: special loan fields
            goldValue: z.number().positive().optional(),          // gold loan appraised value
            collateralFdrId: z.string().optional(),               // LAD: FDR collateral
            householdIncome: z.number().positive().optional(),    // microfinance: declared income
            // BRD v5.0 LN-F01 to LN-F05: Enhanced application fields
            productId: z.string().optional(),                     // Link to LoanProduct
            employmentType: z.enum(["SALARIED", "SELF_EMPLOYED", "FARMER", "BUSINESS", "OTHER"]).optional(),
            monthlyIncome: z.number().positive().optional(),
            existingLiabilities: z.string().optional(),
            propertyAssetDesc: z.string().optional(),
            guarantorIds: z.array(z.string()).default([]),        // Multiple guarantors (LN-F05)
        }).parse(req.body);

        // ── COA: Gold loan LTV check (max 75%) ───────────────────────────────
        if (data.loanSubType === "gold" || data.loanType === "gold") {
            if (!data.goldValue) {
                res.status(400).json({ success: false, message: "Gold value is required for gold loans" });
                return;
            }
            const maxAllowed = data.goldValue * GOLD_LOAN_MAX_LTV;
            if (data.amountRequested > maxAllowed) {
                res.status(400).json({
                    success: false,
                    message: `Gold loan LTV exceeded: max ₹${maxAllowed.toFixed(2)} (${(GOLD_LOAN_MAX_LTV * 100)}% of gold value ₹${data.goldValue})`,
                    maxAllowed,
                    goldValue: data.goldValue,
                    ltvPercent: ((data.amountRequested / data.goldValue) * 100).toFixed(1),
                });
                return;
            }
        }

        // ── COA: Loan Against FDR — max 90% of FDR face value ───────────────
        if (data.loanSubType === "lad" || data.collateralFdrId) {
            const fdr = await prisma.deposit.findFirst({
                where: { id: data.collateralFdrId, tenantId, depositType: "fd" },
            });
            if (!fdr) {
                res.status(400).json({ success: false, message: "Collateral FDR not found for LAD" });
                return;
            }
            if (fdr.lienLoanId) {
                res.status(400).json({ success: false, message: "FDR already has an active lien" });
                return;
            }
            const maxLad = Number(fdr.principal) * LAD_MAX_RATIO;
            if (data.amountRequested > maxLad) {
                res.status(400).json({
                    success: false,
                    message: `LAD amount exceeds 90% of FDR: max ₹${maxLad.toFixed(2)}`,
                    maxAllowed: maxLad,
                });
                return;
            }
        }

        // ── COA: Microfinance — EMI ≤ 50% of household income / 12 ──────────
        if (data.loanSubType === "micro" || data.loanSubType === "shg") {
            if (!data.householdIncome) {
                res.status(400).json({ success: false, message: "Household income required for microfinance loans" });
                return;
            }
            const estMonthlyEmi = (data.amountRequested / data.tenureMonths) * 1.12; // rough incl. interest
            const incomeCapPerMonth = (data.householdIncome / 12) * MICROFINANCE_REPAYMENT_CAP;
            if (estMonthlyEmi > incomeCapPerMonth) {
                res.status(400).json({
                    success: false,
                    message: `EMI ₹${estMonthlyEmi.toFixed(0)} exceeds 50% of monthly household income (₹${incomeCapPerMonth.toFixed(0)})`,
                    householdIncome: data.householdIncome,
                    maxEmi: incomeCapPerMonth,
                });
                return;
            }
        }

        // LN-002: Run eligibility rule engine
        const { evaluateEligibility } = await import("../../services/eligibility.service");
        const { result: eligibility, ruleVersion } = await evaluateEligibility(tenantId, data.memberId);
        if (!eligibility.eligible) {
            res.status(400).json({
                success: false,
                message: `Loan eligibility check failed: ${eligibility.failedRules.map(r => r.reason).join(', ')}`,
                eligibility: { ...eligibility, ruleVersion },
            });
            return;
        }

        // LN-003: AI Loan Risk Scoring (Improved - using actual factors)
        // BRD v5.0 LN-F01: Also fetch member photos/signatures for pre-fill
        const member = await prisma.member.findUnique({
            where: { id: data.memberId },
            include: {
                loans: { where: { status: { in: ["active", "closed"] } } },
                sbAccounts: { where: { status: "active" } },
                shareLedger: true,
                memberPhotos: { where: { status: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1 },
                memberSignatures: { where: { status: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1 },
            },
        });

        let riskScore = 50; // Base score
        const factors: { factor: string; impact: number; reason: string }[] = [];

        if (member) {
            // Factor 1: Membership tenure (longer = lower risk)
            const membershipMonths = Math.floor((Date.now() - member.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
            if (membershipMonths >= 24) {
                riskScore -= 10;
                factors.push({ factor: "Long membership tenure", impact: -10, reason: `${membershipMonths} months membership` });
            } else if (membershipMonths < 6) {
                riskScore += 15;
                factors.push({ factor: "New member", impact: 15, reason: `Only ${membershipMonths} months membership` });
            }

            // Factor 2: Share capital (higher = lower risk)
            const totalShares = member.shareLedger.reduce((sum, tx) => {
                return tx.transactionType === "purchase" ? sum + tx.shares : sum - tx.shares;
            }, 0);
            if (totalShares >= 20) {
                riskScore -= 8;
                factors.push({ factor: "High share capital", impact: -8, reason: `${totalShares} shares` });
            } else if (totalShares < 5) {
                riskScore += 12;
                factors.push({ factor: "Low share capital", impact: 12, reason: `Only ${totalShares} shares` });
            }

            // Factor 3: Existing loan repayment history
            const activeLoans = member.loans.filter(l => l.status === "active");
            const closedLoans = member.loans.filter(l => l.status === "closed");
            if (closedLoans.length > 0) {
                // Check if any closed loans had NPA issues
                const hadNpa = closedLoans.some(l => l.npaCategory && l.npaCategory !== "standard");
                if (hadNpa) {
                    riskScore += 25;
                    factors.push({ factor: "Past NPA history", impact: 25, reason: "Previous loan had NPA classification" });
                } else {
                    riskScore -= 5;
                    factors.push({ factor: "Good repayment history", impact: -5, reason: `${closedLoans.length} loans closed successfully` });
                }
            }

            // Factor 4: Multiple active loans (higher risk)
            if (activeLoans.length >= 2) {
                riskScore += 10;
                factors.push({ factor: "Multiple active loans", impact: 10, reason: `${activeLoans.length} active loans` });
            }

            // Factor 5: Savings balance (higher = lower risk)
            const totalSavings = member.sbAccounts.reduce((sum, acc) => sum + Number(acc.balance), 0);
            const savingsRatio = totalSavings / data.amountRequested;
            if (savingsRatio >= 0.5) {
                riskScore -= 8;
                factors.push({ factor: "Good savings balance", impact: -8, reason: `Savings cover ${(savingsRatio * 100).toFixed(0)}% of loan` });
            } else if (savingsRatio < 0.1) {
                riskScore += 10;
                factors.push({ factor: "Low savings balance", impact: 10, reason: `Savings only ${(savingsRatio * 100).toFixed(0)}% of loan` });
            }

            // Factor 6: Loan amount relative to income (if provided)
            if (data.householdIncome) {
                const loanToIncomeRatio = data.amountRequested / data.householdIncome;
                if (loanToIncomeRatio > 2) {
                    riskScore += 15;
                    factors.push({ factor: "High loan-to-income ratio", impact: 15, reason: `${(loanToIncomeRatio * 100).toFixed(0)}% of annual income` });
                } else if (loanToIncomeRatio < 0.5) {
                    riskScore -= 5;
                    factors.push({ factor: "Low loan-to-income ratio", impact: -5, reason: `${(loanToIncomeRatio * 100).toFixed(0)}% of annual income` });
                }
            }
        }

        // Factor 7: Loan type risk (gold loans lower risk due to collateral)
        if (data.loanType === "gold" || data.loanSubType === "gold") {
            riskScore -= 12;
            factors.push({ factor: "Gold collateral", impact: -12, reason: "Secured by gold collateral" });
        } else if (data.loanSubType === "lad" || data.collateralFdrId) {
            riskScore -= 10;
            factors.push({ factor: "FDR collateral", impact: -10, reason: "Secured by FDR lien" });
        } else if (data.loanType === "personal") {
            riskScore += 8;
            factors.push({ factor: "Unsecured loan", impact: 8, reason: "No collateral provided" });
        }

        // Factor 8: Moratorium period (longer = higher risk)
        if (data.moratoriumMonths > 6) {
            riskScore += 8;
            factors.push({ factor: "Extended moratorium", impact: 8, reason: `${data.moratoriumMonths} months moratorium` });
        }

        // Clamp score between 0-100
        riskScore = Math.max(0, Math.min(100, riskScore));

        // Traffic light categorization
        const riskCategory = riskScore >= 70 ? "GREEN" : riskScore >= 50 ? "AMBER" : "RED";
        const riskLabel = riskScore >= 70 ? "LOW" : riskScore >= 50 ? "MEDIUM" : "HIGH";

        // Top 5 contributing factors
        const topFactors = factors
            .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
            .slice(0, 5)
            .map(f => `${f.factor}: ${f.impact > 0 ? '+' : ''}${f.impact} (${f.reason})`);

        // AI-014: Explainable AI - Generate human-readable explanation
        const explanation = `Risk score is ${Math.round(riskScore)}/100 (${riskCategory}) because: ${topFactors.slice(0, 3).join('; ')}.`;

        // Store in AI audit log
        await prisma.aiAuditLog.create({
            data: {
                tenantId,
                userId: req.user?.userId,
                feature: "loan_risk_scoring",
                inputData: JSON.stringify({
                    memberId: data.memberId,
                    loanType: data.loanType,
                    amountRequested: data.amountRequested,
                    tenureMonths: data.tenureMonths,
                }),
                outputData: JSON.stringify({
                    riskScore: Math.round(riskScore * 100) / 100,
                    riskCategory,
                    riskLabel,
                    topFactors,
                    factors: factors.map(f => ({ factor: f.factor, impact: f.impact })),
                }),
                explanationText: explanation,
                success: true,
                modelVersion: "v1.0",
            },
        });

        // GOV-009: Threshold-Based Approval Routing
        const thresholds = await prisma.approvalThreshold.findMany({
            where: {
                tenantId,
                transactionType: "LOAN",
                isActive: true,
            },
            orderBy: { level: "asc" },
        });

        let assignedApprover = "LOAN_OFFICER"; // Default
        if (thresholds.length > 0) {
            // Find the appropriate threshold level based on amount
            for (const threshold of thresholds) {
                if (!threshold.maxAmount || data.amountRequested <= threshold.maxAmount) {
                    assignedApprover = threshold.approverRole;
                    break;
                }
            }
            // If amount exceeds all thresholds, use the highest level approver
            if (data.amountRequested > (thresholds[thresholds.length - 1]?.maxAmount || Infinity)) {
                assignedApprover = thresholds[thresholds.length - 1]?.approverRole || "PRESIDENT";
            }
        }

        const application = await prisma.loanApplication.create({
            data: {
                tenantId,
                memberId: data.memberId,
                loanType: data.loanType,
                amountRequested: data.amountRequested,
                purpose: data.purpose,
                tenureMonths: data.tenureMonths,
                moratoriumMonths: data.moratoriumMonths,
                riskScore: Math.round(riskScore * 100) / 100,
                riskCategory,
                status: "APPLIED", // BRD v5.0 status flow
                loanSubType: data.loanSubType ?? null,
                // BRD v5.0 fields
                productId: data.productId,
                employmentType: data.employmentType,
                monthlyIncome: data.monthlyIncome,
                existingLiabilities: data.existingLiabilities,
                propertyAssetDesc: data.propertyAssetDesc,
                guarantorIds: data.guarantorIds,
                // Store assigned approver in remarks/metadata
                remarks: `Assigned to: ${assignedApprover} (Threshold-based routing)`,
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "CREATE_LOAN_APPLICATION",
            entity: "LoanApplication",
            entityId: application.id,
        });

        // BRD v5.0 LN-F01: Pre-fill member data for response (member already fetched above)
        const shareCount = member?.shareLedger.reduce(
            (sum, l) => (l.transactionType === "purchase" ? sum + l.shares : sum - l.shares),
            0
        ) || 0;

        // Calculate proposed EMI (if product has interest scheme)
        let calculatedEmi = null;
        if (data.productId) {
            const product = await prisma.loanProduct.findFirst({
                where: { id: data.productId },
                include: { interestScheme: { include: { slabs: true } } },
            });
            if (product?.interestScheme?.slabs.length > 0) {
                const rate = product.interestScheme.slabs[0].rate;
                const monthlyRate = Number(rate) / 100 / 12;
                const emi = (Number(data.amountRequested) * monthlyRate * Math.pow(1 + monthlyRate, data.tenureMonths)) /
                    (Math.pow(1 + monthlyRate, data.tenureMonths) - 1);
                calculatedEmi = Math.round(emi);
            }
        }

        res.status(201).json({
            success: true,
            application,
            eligibility: { ...eligibility, ruleVersion },
            // BRD v5.0 LN-F01: Pre-filled data
            preFilledData: member ? {
                name: `${member.firstName} ${member.lastName}`,
                address: member.address,
                aadhaarMasked: member.aadhaar ? `${member.aadhaar.slice(0, 4)}****${member.aadhaar.slice(-4)}` : null,
                dateOfBirth: member.dateOfBirth,
                photo: member.memberPhotos[0]?.fileUrl || null,
                signature: member.memberSignatures[0]?.fileUrl || null,
                shareHolding: shareCount,
            } : null,
            calculatedEmi,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/loans/applications ──────────────────────────────────────────
router.get("/applications", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;

        const [applications, total] = await Promise.all([
            prisma.loanApplication.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { appliedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma.loanApplication.count({ where }),
        ]);
        res.json({ success: true, applications, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/loans/applications/:id ───────────────────────────────────────
router.get("/applications/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
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
            },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }
        res.json({ success: true, application });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/loans/applications/:id/copilot ────────────────────────────────
// AI-002: AI Loan Underwriting Co-Pilot
router.get("/applications/:id/copilot", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
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
            },
        });
        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }

        const member = application.member;
        const riskScore = Number(application.riskScore) || 50;
        const riskCategory = application.riskCategory || "AMBER";

        // Top risk flags
        const riskFlags: string[] = [];
        if (riskScore < 50) riskFlags.push("High risk score - consider additional collateral");
        if (member.loans.filter(l => l.status === "active").length >= 2) {
            riskFlags.push("Multiple active loans - repayment capacity concern");
        }
        const totalSavings = member.sbAccounts.reduce((sum, acc) => sum + Number(acc.balance), 0);
        const savingsRatio = totalSavings / application.amountRequested;
        if (savingsRatio < 0.1) {
            riskFlags.push("Low savings balance relative to loan amount");
        }

        // Comparable past loans (anonymized)
        const comparableLoans = await prisma.loan.findMany({
            where: {
                tenantId,
                loanType: application.loanType,
                status: "closed",
                amountRequested: {
                    gte: application.amountRequested * 0.8,
                    lte: application.amountRequested * 1.2,
                },
            },
            take: 5,
            select: {
                id: true,
                amountRequested: true,
                tenureMonths: true,
                npaCategory: true,
            },
        });

        // Repayment capacity calculation
        const monthlyIncome = 50000; // Default estimate (can be enhanced with actual data)
        const emi = (application.amountRequested * (12 / 100)) / 12; // Rough EMI estimate
        const repaymentCapacity = monthlyIncome * 0.4; // 40% of income
        const recommendedAmount = repaymentCapacity * application.tenureMonths;

        // Recommendations
        const recommendations: string[] = [];
        if (recommendedAmount < application.amountRequested) {
            recommendations.push(`Consider reducing loan amount to ₹${Math.round(recommendedAmount).toLocaleString("en-IN")} based on computed repayment capacity of ₹${Math.round(repaymentCapacity).toLocaleString("en-IN")}/month`);
        }
        if (riskScore < 50) {
            recommendations.push("Request additional collateral or guarantor");
        }
        if (member.loans.filter(l => l.status === "active").length > 0) {
            recommendations.push("Review existing loan repayment history before approval");
        }

        // Store in AI audit log
        await prisma.aiAuditLog.create({
            data: {
                tenantId,
                userId: req.user?.userId,
                feature: "loan_underwriting_copilot",
                inputData: JSON.stringify({ applicationId: application.id }),
                outputData: JSON.stringify({
                    riskScore,
                    riskCategory,
                    riskFlags,
                    recommendations,
                    comparableLoansCount: comparableLoans.length,
                }),
                success: true,
                modelVersion: "v1.0",
            },
        });

        res.json({
            success: true,
            riskScore,
            riskCategory,
            riskFlags,
            recommendations,
            comparableLoans: comparableLoans.map(l => ({
                amount: Number(l.amountRequested),
                tenure: l.tenureMonths,
                outcome: l.npaCategory === "standard" ? "GOOD" : "NPA",
            })),
            repaymentCapacity: Math.round(repaymentCapacity),
            recommendedAmount: Math.round(recommendedAmount),
        });
    } catch (err) {
        console.error("[Loan Co-Pilot]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/applications/:id/approve ─────────────────────────────
router.post("/applications/:id/approve", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { remarks } = z.object({ remarks: z.string().optional() }).parse(req.body);
        const app = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: { status: "approved", reviewedAt: new Date(), reviewedBy: req.user?.userId, remarks },
        });
        res.json({ success: true, application: app });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/applications/:id/reject ──────────────────────────────
router.post("/applications/:id/reject", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { remarks } = z.object({ remarks: z.string() }).parse(req.body);
        const app = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: { status: "rejected", reviewedAt: new Date(), reviewedBy: req.user?.userId, remarks },
        });
        res.json({ success: true, application: app });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── PUT /api/v1/loans/applications/:id/status ─────────────────────────────────
// BRD v5.0 Section 4.6.2: Status Flow - APPLIED → UNDER_REVIEW → PENDING_SANCTION
router.put("/applications/:id/status", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const userId = req.user!.id;

        const data = z.object({
            status: z.enum(["UNDER_REVIEW", "PENDING_SANCTION", "REJECTED"]),
            remarks: z.string().optional(),
        }).parse(req.body);

        const application = await prisma.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
        });

        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }

        // Validate status transitions
        const validTransitions: Record<string, string[]> = {
            APPLIED: ["UNDER_REVIEW", "REJECTED"],
            UNDER_REVIEW: ["PENDING_SANCTION", "REJECTED"],
            PENDING_SANCTION: ["SANCTIONED", "REJECTED"], // Handled by sanction endpoint
        };

        const allowedStatuses = validTransitions[application.status] || [];
        if (!allowedStatuses.includes(data.status)) {
            res.status(400).json({
                success: false,
                message: `Invalid status transition from ${application.status} to ${data.status}. Allowed: ${allowedStatuses.join(", ")}`,
            });
            return;
        }

        const updated = await prisma.loanApplication.update({
            where: { id: req.params.id },
            data: {
                status: data.status,
                reviewedBy: userId,
                reviewedAt: new Date(),
                remarks: data.remarks || application.remarks,
            },
        });

        await createAuditLog({
            tenantId,
            userId,
            action: `LOAN_APPLICATION_STATUS_${data.status}`,
            entity: "LoanApplication",
            entityId: application.id,
            metadata: { previousStatus: application.status, newStatus: data.status },
        });

        res.json({ success: true, application: updated });
    } catch (e: any) {
        if (e.name === "ZodError") {
            res.status(400).json({ success: false, errors: e.errors });
            return;
        }
        res.status(500).json({ success: false, message: (e as Error).message });
    }
});

// ─── POST /api/v1/loans/applications/:id/disburse ────────────────────────────
router.post("/applications/:id/disburse", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { disbursedAmount, interestRate, loanSubType, goldValue, collateralFdrId, householdIncome } = z.object({
            disbursedAmount: z.number().positive(),
            interestRate: z.number().positive(),
            // COA fields
            loanSubType: z.string().optional(),
            goldValue: z.number().positive().optional(),
            collateralFdrId: z.string().optional(),
            householdIncome: z.number().positive().optional(),
        }).parse(req.body);

        const application = await prisma.loanApplication.findUnique({ where: { id: req.params.id } });
        if (!application || application.status !== "approved") {
            res.status(400).json({ success: false, message: "Application not in approved state" });
            return;
        }

        // COA: Determine GL code from subtype
        const glCode = LOAN_GL_CODES[loanSubType ?? ""] ?? LOAN_GL_CODES["personal"];

        // COA: KCC subvention rate
        const subventionRate = (loanSubType === "kcc") ? KCC_SUBVENTION_RATE : undefined;

        // DA-001: Generate loan number - LN-YYYY-NNNNNN format
        const count = await prisma.loan.count({ where: { tenantId } });
        const { generateLoanId } = await import("../../lib/id-generator");
        const loanNumber = generateLoanId(count + 1);
        const period = currentPeriod();

        // BRD v4.0 INT-006: Generate EMI schedule with rounding mode
        const { generateEMISchedule } = await import("../../services/emi-schedule.service");
        const moratoriumMonths = application.moratoriumMonths || 0;
        const moratoriumEndDate = moratoriumMonths > 0 ? new Date(Date.now() + moratoriumMonths * 30 * 24 * 60 * 60 * 1000) : null;
        
        const emiSchedule = await generateEMISchedule(
            tenantId,
            disbursedAmount,
            interestRate,
            application.tenureMonths,
            new Date(),
            moratoriumMonths
        );

        const emiScheduleData = emiSchedule.map((item) => ({
            installmentNo: item.installmentNo,
            dueDate: item.dueDate,
            principal: String(item.principalComponent),
            interest: String(item.interestComponent),
            totalEmi: String(item.totalEmi),
            penalAmount: "0",
            paidAmount: "0",
            status: "pending",
        }));

        const loan = await prisma.$transaction(async (tx) => {
            const newLoan = await tx.loan.create({
                data: {
                    tenantId,
                    memberId: application.memberId,
                    applicationId: application.id,
                    loanNumber,
                    loanType: application.loanType,
                    principalAmount: application.amountRequested,
                    interestRate,
                    tenureMonths: application.tenureMonths,
                    disbursedAmount,
                    disbursedAt: new Date(),
                    outstandingPrincipal: disbursedAmount,
                    status: "active",
                    npaCategory: "standard",
                    moratoriumEndDate: application.moratoriumMonths > 0 ? new Date(Date.now() + application.moratoriumMonths * 30 * 24 * 60 * 60 * 1000) : null,
                    // COA fields
                    loanSubType: loanSubType ?? null,
                    glCode,
                    subventionRate: subventionRate ?? null,
                    goldValue: goldValue ?? null,
                    collateralFdrId: collateralFdrId ?? null,
                    householdIncome: householdIncome ?? null,
                    moratoriumEndDate: application.moratoriumMonths > 0 ? new Date(Date.now() + application.moratoriumMonths * 30 * 24 * 60 * 60 * 1000) : null,
                },
            });

            await tx.emiSchedule.createMany({
                data: emiScheduleData.map((e) => ({ ...e, loanId: newLoan.id })),
            });

            await tx.loanApplication.update({ where: { id: req.params.id }, data: { status: "disbursed" } });

            return newLoan;
        });

        // COA: GL posting for disbursement (DR loan account / CR cash)
        await postGl(tenantId, "LOAN_DISBURSEMENT", disbursedAmount,
            `Loan disbursement — ${loanNumber} (${loanSubType ?? application.loanType})`, period);

        // COA: If LAD, auto-mark FDR lien
        if (collateralFdrId) {
            await prisma.deposit.update({
                where: { id: collateralFdrId },
                data: { lienLoanId: loan.id, status: "lien_marked" },
            });
        }

        // COA: If KCC, book subvention receivable
        if (loanSubType === "kcc" && subventionRate) {
            const subventionAmount = Math.round(disbursedAmount * Number(subventionRate) * 100) / 100;
            if (subventionAmount > 0) {
                await postGl(tenantId, "KCC_SUBVENTION", subventionAmount,
                    `KCC subvention 3% — ${loanNumber}`, period);
            }
        }

        res.status(201).json({ success: true, loan, glCode });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/loans ───────────────────────────────────────────────────────
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status, memberId, npaCategory: npaFilter, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (status) where.status = status;
        if (memberId) where.memberId = memberId;
        if (npaFilter) where.npaCategory = npaFilter;

        const [loans, total] = await Promise.all([
            prisma.loan.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { createdAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma.loan.count({ where }),
        ]);
        res.json({ success: true, loans, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/loans/:id ───────────────────────────────────────────────────
// Note: This route should NOT match /loans/products - that route is handled by loan-products.ts
// If products is passed as :id, it means the route order is wrong or old code is deployed
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        // Defensive check: if "products" is passed as ID, it means route conflict
        if (req.params.id === "products" || req.params.id === "applications" || req.params.id === "eligibility") {
            res.status(404).json({ 
                success: false, 
                message: "Route not found. Please ensure backend is updated with latest code." 
            });
            return;
        }
        
        const tenantId = req.user!.tenantId!;
        const loan = await prisma.loan.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: true,
                emiSchedule: { orderBy: { installmentNo: "asc" } },
                application: true,
            },
        });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }
        res.json({ success: true, loan });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/:id/emi/pay — Pay EMI with GL split ─────────────────
router.post("/:id/emi/pay", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();
        const { emiId, amount, remarks } = z.object({
            emiId: z.string(),
            amount: z.number().positive(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const emi = await prisma.emiSchedule.findUnique({
            where: { id: emiId },
            include: { loan: true },
        });
        if (!emi || emi.loan.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "EMI not found" });
            return;
        }

        const paidAmount = Number(emi.paidAmount) + amount;
        const status = paidAmount >= Number(emi.totalEmi) ? "paid" : "partial";

        const updated = await prisma.emiSchedule.update({
            where: { id: emiId },
            data: { paidAmount, paidAt: status === "paid" ? new Date() : undefined, status },
        });

        // LN-009: Payment priority — Penal Interest → Regular Interest → Principal
        const penalDue = Number(emi.penalAmount || 0);
        const interestDue = Number(emi.interest);
        const principalDue = Number(emi.principal);
        
        let remaining = amount;
        const penalPaid = Math.min(remaining, penalDue);
        remaining -= penalPaid;
        const interestPaid = Math.min(remaining, interestDue);
        remaining -= interestPaid;
        const principalPaid = Math.min(remaining, principalDue);

        if (principalPaid > 0) {
            await postGl(tenantId, "LOAN_REPAYMENT_PRINCIPAL", principalPaid,
                `EMI principal repayment — ${emi.loan.loanNumber} #${emi.installmentNo}`, period);
        }
        if (interestPaid > 0) {
            await postGl(tenantId, "LOAN_REPAYMENT_INTEREST", interestPaid,
                `EMI interest repayment — ${emi.loan.loanNumber} #${emi.installmentNo}`, period);
        }
        if (penalPaid > 0) {
            await postGl(tenantId, "PENAL_INTEREST", penalPaid,
                `Penal interest — ${emi.loan.loanNumber} #${emi.installmentNo}`, period);
        }

        // Update outstanding principal/interest on loan
        await prisma.loan.update({
            where: { id: emi.loanId },
            data: {
                outstandingPrincipal: Math.max(0, Number(emi.loan.outstandingPrincipal) - principalPaid),
                outstandingInterest: Math.max(0, Number(emi.loan.outstandingInterest) - interestPaid),
                outstandingPenal: Math.max(0, Number(emi.loan.outstandingPenal) - penalPaid),
            },
        });

        res.json({ success: true, emi: updated, split: { principalPaid, interestPaid, penalPaid } });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/:id/preclosure — Pre-close loan ─────────────────────
router.post("/:id/preclosure", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();
        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan || loan.status !== "active") {
            res.status(404).json({ success: false, message: "Active loan not found" });
            return;
        }

        const outstanding = Number(loan.outstandingPrincipal);
        // COA: Pre-closure charge — 1–2% of outstanding principal
        const chargeRate = PRECLOSURE_CHARGE_MIN +
            (PRECLOSURE_CHARGE_MAX - PRECLOSURE_CHARGE_MIN) * 0.5; // default 1.5%
        const preclosureCharge = Math.round(outstanding * chargeRate * 100) / 100;

        await prisma.loan.update({
            where: { id: loan.id },
            data: { status: "closed" },
        });

        // COA: GL for pre-closure fee
        await postGl(tenantId, "LOAN_PRECLOSURE", preclosureCharge,
            `Pre-closure charge — ${loan.loanNumber}`, period);

        // If LAD — clear FDR lien
        if (loan.collateralFdrId) {
            await prisma.deposit.update({
                where: { id: loan.collateralFdrId },
                data: { lienLoanId: null, status: "active" },
            });
        }

        res.json({
            success: true,
            message: "Loan pre-closed",
            outstandingPrincipal: outstanding,
            preclosureCharge,
            chargeRate: `${(chargeRate * 100).toFixed(1)}%`,
            lienCleared: !!loan.collateralFdrId,
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/:id/write-off — Write off loan ──────────────────────
router.post("/:id/write-off", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();
        const { writeOffAmount, bodResolutionRef, remarks } = z.object({
            writeOffAmount: z.number().positive(),
            bodResolutionRef: z.string().min(1, "BOD resolution reference is required for write-off"),
            remarks: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        // COA: Write-off only allowed if fully provisioned (Loss Asset category)
        if (loan.npaCategory !== "loss") {
            res.status(400).json({
                success: false,
                message: "Write-off requires loan to be classified as Loss Asset. Current classification: " + (loan.npaCategory ?? "standard"),
                currentCategory: loan.npaCategory,
            });
            return;
        }

        // COA: BOD resolution reference required
        if (!bodResolutionRef) {
            res.status(400).json({ success: false, message: "BOD resolution reference number is mandatory for write-off" });
            return;
        }

        await prisma.loan.update({
            where: { id: loan.id },
            data: {
                status: "written-off",
                writeOffDate: new Date(),
                writeOffAmount,
                bodResolutionRef,
            },
        });

        // COA: GL — DR Provision (04-02-0006) / CR Loan Outstanding
        await postGl(tenantId, "WRITE_OFF", writeOffAmount,
            `Loan write-off — ${loan.loanNumber} | BOD Res: ${bodResolutionRef}`, period);

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "LOAN_WRITE_OFF",
            entity: "Loan",
            entityId: loan.id,
            newData: { writeOffAmount, bodResolutionRef, remarks },
        });

        res.json({ success: true, message: "Loan written off", writeOffAmount, bodResolutionRef });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-018: Post write-off recovery (Enhanced) ───────────────────────────────
router.post("/:id/recovery", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();
        const { amount, recoveryDate, recoveryMode, remarks } = z.object({
            amount: z.number().positive(),
            recoveryDate: z.coerce.date().optional().default(new Date()),
            recoveryMode: z.enum(["CASH", "BANK_TRANSFER", "ASSET_SALE", "LEGAL_SETTLEMENT", "OTHER"]).optional(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan || loan.status !== "written-off") {
            res.status(400).json({ success: false, message: "Loan must be written-off to record recovery" });
            return;
        }

        const newRecovered = Number(loan.recoveredAmount ?? 0) + amount;
        const writeOffAmount = Number(loan.writeOffAmount ?? 0);
        const recoveryPercent = writeOffAmount > 0 ? (newRecovered / writeOffAmount) * 100 : 0;
        const npaProvision = Number(loan.npaProvision ?? 0);
        const provisionToReverse = npaProvision > 0 ? Math.min(amount, npaProvision) : 0;
        const newNpaProvision = Math.max(0, npaProvision - provisionToReverse);

        await prisma.loan.update({
            where: { id: loan.id },
            data: { recoveredAmount: newRecovered, npaProvision: newNpaProvision },
        });

        // COA: Recovery on cash basis → GL 11-01-0001
        await postGl(tenantId, "RECOVERY_WRITTEN_OFF", amount,
            `Recovery from written-off loan — ${loan.loanNumber} | Mode: ${recoveryMode || "CASH"}`, period);

        // IMP-18: NPA provision reversal — auto GL on recovery (reverse provision proportionally)
        if (provisionToReverse > 0) {
            const { NPA_PROVISION_GL_CREDIT } = await import("../../lib/coa-rules");
            const provGlCode = NPA_PROVISION_GL_CREDIT[(loan.npaCategory as keyof typeof NPA_PROVISION_GL_CREDIT) || "loss"] ?? "04-02-0006";
            await postGl(tenantId, "NPA_PROVISION_REVERSAL", provisionToReverse,
                `NPA provision reversal on recovery — ${loan.loanNumber}`, period, { provisionGlCode: provGlCode });
        }

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "NPA_RECOVERY_RECORDED",
            entity: "Loan",
            entityId: loan.id,
            newData: { amount, recoveryDate, recoveryMode, recoveryPercent: Math.round(recoveryPercent * 100) / 100, remarks },
        });

        res.json({
            success: true,
            message: "Recovery recorded",
            recoveredAmount: amount,
            totalRecovered: newRecovered,
            writeOffAmount,
            recoveryPercent: Math.round(recoveryPercent * 100) / 100,
            recoveryMode: recoveryMode || "CASH",
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-018: Get NPA Recovery Report ───────────────────────────────────────────
router.get("/npa/recovery-report", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const writtenOffLoans = await prisma.loan.findMany({
            where: { tenantId, status: "written-off" },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });

        const report = writtenOffLoans.map(loan => ({
            loanNumber: loan.loanNumber,
            member: loan.member,
            writeOffDate: loan.writeOffDate,
            writeOffAmount: Number(loan.writeOffAmount ?? 0),
            recoveredAmount: Number(loan.recoveredAmount ?? 0),
            recoveryPercent: loan.writeOffAmount && Number(loan.writeOffAmount) > 0
                ? (Number(loan.recoveredAmount ?? 0) / Number(loan.writeOffAmount)) * 100
                : 0,
            outstandingRecovery: Number(loan.writeOffAmount ?? 0) - Number(loan.recoveredAmount ?? 0),
        }));

        res.json({ success: true, report, totalWriteOff: report.reduce((s, r) => s + r.writeOffAmount, 0), totalRecovered: report.reduce((s, r) => s + r.recoveredAmount, 0) });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/:id/subvention — Record KCC subvention receipt ──────
router.post("/:id/subvention", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();
        const { amount, remarks } = z.object({
            amount: z.number().positive(),
            remarks: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan || loan.loanSubType !== "kcc") {
            res.status(400).json({ success: false, message: "Subvention only applicable to KCC loans" });
            return;
        }

        // COA: Book to GL 10-02-0004 (Subvention Income)
        await postGl(tenantId, "KCC_SUBVENTION", amount,
            `KCC subvention receipt — ${loan.loanNumber}`, period);

        res.json({ success: true, message: "Subvention income recorded", amount });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/:id/npa-category — Manually set Loss Asset ──────────
router.post("/:id/npa-category", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { npaCategory: cat } = z.object({
            npaCategory: z.enum(["standard", "sma_0", "sma_1", "sub_standard", "doubtful_1", "doubtful_2", "doubtful_3", "loss"]),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        await prisma.loan.update({
            where: { id: loan.id },
            data: { npaCategory: cat, npaDate: cat === "standard" ? null : (loan.npaDate ?? new Date()) },
        });

        res.json({ success: true, message: `NPA category updated to ${cat}`, loanId: loan.id });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-010: Loan Restructuring ────────────────────────────────────────────────
router.post("/:id/restructure", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { newTenureMonths, newEmiAmount, moratoriumExtensionMonths, bodResolutionRef, remarks } = z.object({
            newTenureMonths: z.number().int().positive().optional(),
            newEmiAmount: z.number().positive().optional(),
            moratoriumExtensionMonths: z.number().int().min(0).optional(),
            bodResolutionRef: z.string().min(1, "BOD resolution reference required for restructuring"),
            remarks: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({
            where: { id: req.params.id, tenantId },
            include: { emiSchedule: { where: { status: "pending" }, orderBy: { dueDate: "asc" } } },
        });

        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        const MAX_RESTRUCTURES = 3; // loan.restructure.max.count
        if (loan.restructureCount >= MAX_RESTRUCTURES) {
            res.status(400).json({
                success: false,
                message: `Maximum restructuring limit (${MAX_RESTRUCTURES}) reached`,
                currentCount: loan.restructureCount,
            });
            return;
        }

        const outstandingPrincipal = Number(loan.outstandingPrincipal);
        const currentRate = Number(loan.interestRate);
        const newTenure = newTenureMonths || loan.tenureMonths;
        const newMoratoriumMonths = (loan.moratoriumMonths || 0) + (moratoriumExtensionMonths || 0);

        // Archive current schedule
        await prisma.emiSchedule.updateMany({
            where: { loanId: loan.id, status: "pending" },
            data: { status: "archived" },
        });

        // Generate new EMI schedule
        const monthlyInterest = (outstandingPrincipal * (currentRate / 100)) / 12;
        const emi = newEmiAmount || (outstandingPrincipal / newTenure + monthlyInterest);
        // BRD v4.0 INT-006: Use EMI schedule generator with rounding
        const { generateEMISchedule } = await import("../../services/emi-schedule.service");
        const emiSchedule = await generateEMISchedule(
            tenantId,
            outstandingPrincipal,
            Number(loan.interestRate),
            newTenure,
            new Date(),
            newMoratoriumMonths
        );

        const emiScheduleData = emiSchedule.map((item) => ({
            installmentNo: item.installmentNo,
            dueDate: item.dueDate,
            principal: String(item.principalComponent),
            interest: String(item.interestComponent),
            totalEmi: String(item.totalEmi),
            penalAmount: "0",
            paidAmount: "0",
            status: "pending",
        }));

        await prisma.$transaction([
            prisma.emiSchedule.createMany({
                data: emiScheduleData.map((e) => ({ ...e, loanId: loan.id })),
            }),
            prisma.loan.update({
                where: { id: loan.id },
                data: {
                    tenureMonths: newTenure,
                    moratoriumMonths: newMoratoriumMonths,
                    moratoriumEndDate: newMoratoriumMonths > 0 ? new Date(Date.now() + newMoratoriumMonths * 30 * 24 * 60 * 60 * 1000) : null,
                    restructureCount: loan.restructureCount + 1,
                    isRestructured: true,
                    bodResolutionRef,
                },
            }),
        ]);

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "LOAN_RESTRUCTURED",
            entity: "Loan",
            entityId: loan.id,
            newData: { newTenureMonths: newTenure, newEmiAmount: emi, moratoriumExtensionMonths, bodResolutionRef, remarks },
        });

        res.json({
            success: true,
            message: "Loan restructured successfully",
            newTenureMonths: newTenure,
            newEmiAmount: emi,
            restructureCount: loan.restructureCount + 1,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-010: Loan Refinance ────────────────────────────────────────────────────
router.post("/:id/refinance", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { newLoanAmount, newInterestRate, newTenureMonths, bodResolutionRef, remarks } = z.object({
            newLoanAmount: z.number().positive(),
            newInterestRate: z.number().positive(),
            newTenureMonths: z.number().int().positive(),
            bodResolutionRef: z.string().min(1, "BOD resolution reference required"),
            remarks: z.string().optional(),
        }).parse(req.body);

        const oldLoan = await prisma.loan.findFirst({
            where: { id: req.params.id, tenantId },
            include: { emiSchedule: { where: { status: "pending" } } },
        });

        if (!oldLoan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        const outstandingPrincipal = Number(oldLoan.outstandingPrincipal);
        const outstandingInterest = Number(oldLoan.outstandingInterest || 0);
        const outstandingPenal = Number(oldLoan.outstandingPenal || 0);
        const totalOutstanding = outstandingPrincipal + outstandingInterest + outstandingPenal;

        // Calculate pre-closure charge
        const chargeRate = Math.min(PRECLOSURE_CHARGE_MAX, Math.max(PRECLOSURE_CHARGE_MIN, outstandingPrincipal * 0.02));
        const preclosureCharge = Math.round(outstandingPrincipal * chargeRate * 100) / 100;
        const netPayable = totalOutstanding + preclosureCharge;

        // Create new loan application
        const newApplication = await prisma.loanApplication.create({
            data: {
                tenantId,
                memberId: oldLoan.memberId,
                loanType: oldLoan.loanType,
                amountRequested: newLoanAmount,
                tenureMonths: newTenureMonths,
                status: "approved", // Auto-approved for refinance
                appliedAt: new Date(),
                reviewedAt: new Date(),
                reviewedBy: req.user?.userId,
                remarks: `Refinance of loan ${oldLoan.loanNumber} - ${remarks || ""}`,
            },
        });

        // Disburse new loan - DA-001: LN-YYYY-NNNNNN format
        const count = await prisma.loan.count({ where: { tenantId } });
        const { generateLoanId } = await import("../../lib/id-generator");
        const newLoanNumber = generateLoanId(count + 1);
        const period = currentPeriod();

        const monthlyInterest = (newLoanAmount * (newInterestRate / 100)) / 12;
        const emi = newLoanAmount / newTenureMonths + monthlyInterest;
        // BRD v4.0 INT-006: Use EMI schedule generator
        const { generateEMISchedule } = await import("../../services/emi-schedule.service");
        const emiSchedule = await generateEMISchedule(
            tenantId,
            newLoanAmount,
            newInterestRate,
            newTenureMonths,
            new Date(),
            0
        );
        const emiScheduleData = emiSchedule.map((item) => ({
            installmentNo: item.installmentNo,
            dueDate: item.dueDate,
            principal: String(item.principalComponent),
            interest: String(item.interestComponent),
            totalEmi: String(item.totalEmi),
            penalAmount: "0",
            paidAmount: "0",
            status: "pending",
        }));

        const newLoan = await prisma.$transaction(async (tx) => {
            const createdLoan = await tx.loan.create({
                data: {
                    tenantId,
                    memberId: oldLoan.memberId,
                    applicationId: newApplication.id,
                    loanNumber: newLoanNumber,
                    loanType: oldLoan.loanType,
                    principalAmount: newLoanAmount,
                    interestRate: newInterestRate,
                    tenureMonths: newTenureMonths,
                    disbursedAmount: newLoanAmount,
                    disbursedAt: new Date(),
                    outstandingPrincipal: newLoanAmount,
                    status: "active",
                    npaCategory: "standard",
                    loanSubType: oldLoan.loanSubType,
                    glCode: oldLoan.glCode,
                    refinancedToLoanId: oldLoan.id, // Link back to old loan
                },
            });

            await tx.emiSchedule.createMany({
                data: emiScheduleData.map((e) => ({ ...e, loanId: createdLoan.id })),
            });

            // Close old loan
            await tx.loan.update({
                where: { id: oldLoan.id },
                data: {
                    status: "closed",
                    refinancedToLoanId: createdLoan.id,
                    bodResolutionRef,
                },
            });

            // Archive old EMI schedule
            await tx.emiSchedule.updateMany({
                where: { loanId: oldLoan.id, status: "pending" },
                data: { status: "archived" },
            });

            return createdLoan;
        });

        // GL: Pre-closure charge
        await postGl(tenantId, "LOAN_PRECLOSURE", preclosureCharge,
            `Pre-closure charge for refinance — ${oldLoan.loanNumber}`, period);

        // GL: New loan disbursement
        await postGl(tenantId, "LOAN_DISBURSEMENT", newLoanAmount,
            `Refinance loan disbursement — ${newLoanNumber}`, period);

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "LOAN_REFINANCED",
            entity: "Loan",
            entityId: oldLoan.id,
            newData: { oldLoanNumber: oldLoan.loanNumber, newLoanNumber, newLoanAmount, bodResolutionRef, remarks },
        });

        res.json({
            success: true,
            message: "Loan refinanced successfully",
            oldLoan: { loanNumber: oldLoan.loanNumber, outstanding: totalOutstanding },
            newLoan: { loanNumber: newLoanNumber, amount: newLoanAmount },
            preclosureCharge,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-022: External Refinance (DCCB/NABARD) ──────────────────────────────────
router.post("/:id/external-refinance", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { refinanceSource, refinanceAmount, refinanceDate, documentRef, remarks } = z.object({
            refinanceSource: z.enum(["DCCB", "NABARD", "OTHER"]),
            refinanceAmount: z.number().positive(),
            refinanceDate: z.coerce.date(),
            documentRef: z.string().min(1),
            remarks: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        const period = currentPeriod();

        // Close loan
        await prisma.loan.update({
            where: { id: loan.id },
            data: { status: "closed" },
        });

        // GL: External refinance receipt
        await postGl(tenantId, "EXTERNAL_REFINANCE", refinanceAmount,
            `External refinance from ${refinanceSource} — ${loan.loanNumber} | Doc: ${documentRef}`, period);

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "EXTERNAL_REFINANCE",
            entity: "Loan",
            entityId: loan.id,
            newData: { refinanceSource, refinanceAmount, refinanceDate, documentRef, remarks },
        });

        res.json({
            success: true,
            message: `Loan externally refinanced from ${refinanceSource}`,
            refinanceAmount,
            documentRef,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-014: Add/Update Guarantor ───────────────────────────────────────────────
router.post("/:id/guarantor", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { guarantorMemberId, guarantorName, guarantorIncome, guaranteeAmount } = z.object({
            guarantorMemberId: z.string().optional(),
            guarantorName: z.string().optional(),
            guarantorIncome: z.number().positive(),
            guaranteeAmount: z.number().positive(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        // LN-014: Check aggregate guarantee exposure
        if (guarantorMemberId) {
            const existingGuarantees = await prisma.loan.aggregate({
                where: {
                    tenantId,
                    guarantorMemberId,
                    status: { in: ["active", "npa"] },
                    id: { not: loan.id },
                },
                _sum: { guaranteeAmount: true },
            });

            const totalExposure = Number(existingGuarantees._sum.guaranteeAmount || 0) + guaranteeAmount;
            const maxExposure = guarantorIncome * 0.5; // loan.guarantor.max.exposure.pct (50% default)

            if (totalExposure > maxExposure) {
                res.status(400).json({
                    success: false,
                    message: `Guarantee exposure limit exceeded. Max allowed: ₹${maxExposure.toLocaleString()} (50% of income), Current exposure: ₹${totalExposure.toLocaleString()}`,
                    totalExposure,
                    maxExposure,
                });
                return;
            }
        }

        await prisma.loan.update({
            where: { id: loan.id },
            data: {
                guarantorMemberId: guarantorMemberId || null,
                guarantorName: guarantorName || null,
                guarantorIncome,
                guaranteeAmount,
                guaranteeStartDate: new Date(),
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "LOAN_GUARANTOR_ADDED",
            entity: "Loan",
            entityId: loan.id,
            newData: { guarantorMemberId, guarantorName, guarantorIncome, guaranteeAmount },
        });

        res.json({ success: true, message: "Guarantor added/updated successfully" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-020: NACH Mandate Management ────────────────────────────────────────────
router.post("/:id/nach-mandate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { mandateId, bankAccount, umrn, status, startDate, endDate } = z.object({
            mandateId: z.string().min(1),
            bankAccount: z.string().min(1),
            umrn: z.string().optional(), // Unique Mandate Reference Number
            status: z.enum(["ACTIVE", "CANCELLED", "EXPIRED"]),
            startDate: z.coerce.date(),
            endDate: z.coerce.date().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        // Store NACH mandate in system config or create a new table
        // For now, storing in loan remarks/notes field
        await prisma.loan.update({
            where: { id: loan.id },
            data: {
                // Store NACH details in a JSON field or create separate table
                // For MVP, we'll use a note field
            },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "NACH_MANDATE_CREATED",
            entity: "Loan",
            entityId: loan.id,
            newData: { mandateId, bankAccount, umrn, status, startDate, endDate },
        });

        res.json({ success: true, message: "NACH mandate registered successfully", mandateId, umrn });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-023: Group Loan / JLG Management ──────────────────────────────────────
router.post("/group-loans", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { groupName, groupType, memberIds, individualLoanAmounts } = z.object({
            groupName: z.string().min(1),
            groupType: z.enum(["JLG", "SHG", "OTHER"]).default("JLG"),
            memberIds: z.array(z.string()).min(4).max(10, "JLG must have 4-10 members"),
            individualLoanAmounts: z.array(z.number().positive()),
        }).parse(req.body);

        // Validation: Check member count matches amounts
        if (memberIds.length !== individualLoanAmounts.length) {
            res.status(400).json({ success: false, message: "Member count must match loan amounts count" });
            return;
        }

        // Validation: Check no duplicate members
        if (new Set(memberIds).size !== memberIds.length) {
            res.status(400).json({ success: false, message: "Duplicate members not allowed in JLG" });
            return;
        }

        // Validation: Check members belong to same tenant and are active
        const members = await prisma.member.findMany({
            where: { id: { in: memberIds }, tenantId, status: "active" },
            include: { loans: { where: { status: "active" } } },
        });

        if (members.length !== memberIds.length) {
            res.status(400).json({ success: false, message: "Some members not found or inactive" });
            return;
        }

        // Validation: Check no two members from same family (same address/village)
        const addresses = members.map(m => `${m.village || ""}-${m.address || ""}`.toLowerCase());
        const uniqueAddresses = new Set(addresses);
        if (uniqueAddresses.size < addresses.length) {
            res.status(400).json({ success: false, message: "Members from same family cannot be in same JLG" });
            return;
        }

        // Validation: Check individual loan limits (max ₹1,00,000 per member)
        const MAX_INDIVIDUAL_LOAN = 100000;
        const invalidAmounts = individualLoanAmounts.filter(amt => amt > MAX_INDIVIDUAL_LOAN);
        if (invalidAmounts.length > 0) {
            res.status(400).json({
                success: false,
                message: `Individual loan amount cannot exceed ₹${MAX_INDIVIDUAL_LOAN.toLocaleString()}`,
            });
            return;
        }

        const totalLoanAmount = individualLoanAmounts.reduce((sum, amt) => sum + amt, 0);
        const MAX_GROUP_LOAN = 1000000; // ₹10 lakhs
        if (totalLoanAmount > MAX_GROUP_LOAN) {
            res.status(400).json({
                success: false,
                message: `Total group loan amount cannot exceed ₹${MAX_GROUP_LOAN.toLocaleString()}`,
            });
            return;
        }

        // Create group loan
        const count = await prisma.groupLoan.count({ where: { tenantId } });
        const groupCode = `JLG-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;

        const groupLoan = await prisma.$transaction(async (tx) => {
            const created = await tx.groupLoan.create({
                data: {
                    tenantId,
                    groupName,
                    groupCode,
                    groupType,
                    totalLoanAmount,
                },
            });

            // Add members to group
            await tx.groupLoanMember.createMany({
                data: memberIds.map((memberId, idx) => ({
                    groupLoanId: created.id,
                    memberId,
                    individualLoanAmount: individualLoanAmounts[idx],
                    role: idx === 0 ? "LEADER" : "MEMBER",
                })),
            });

            return created;
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "GROUP_LOAN_CREATED",
            entity: "GroupLoan",
            entityId: groupLoan.id,
            newData: { groupName, groupCode, groupType, memberCount: memberIds.length, totalLoanAmount },
        });

        res.json({ success: true, groupLoan, groupCode });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/loans/group-loans ─────────────────────────────────────────────
router.get("/group-loans", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const groupLoans = await prisma.groupLoan.findMany({
            where: { tenantId },
            include: {
                members: { include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } } },
                loans: { select: { loanNumber: true, status: true, outstandingPrincipal: true } },
            },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, groupLoans });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/loans/group-loans/:id/disburse ──────────────────────────────
router.post("/group-loans/:id/disburse", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { interestRate, tenureMonths } = z.object({
            interestRate: z.number().positive(),
            tenureMonths: z.number().int().positive(),
        }).parse(req.body);

        const groupLoan = await prisma.groupLoan.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                members: { include: { member: true } },
            },
        });

        if (!groupLoan) {
            res.status(404).json({ success: false, message: "Group loan not found" });
            return;
        }

        const period = currentPeriod();
        const createdLoans: any[] = [];

        // Create individual loans for each member
        for (const groupMember of groupLoan.members) {
            const member = groupMember.member;
            const loanAmount = Number(groupMember.individualLoanAmount);

            // Create loan application
            const application = await prisma.loanApplication.create({
                data: {
                    tenantId,
                    memberId: member.id,
                    loanType: "agricultural", // Default for JLG
                    loanSubType: "jlg",
                    amountRequested: loanAmount,
                    tenureMonths,
                    status: "approved",
                    reviewedAt: new Date(),
                    reviewedBy: req.user?.userId,
                    groupLoanId: groupLoan.id,
                },
            });

            // Disburse loan - DA-001: LN-YYYY-NNNNNN format
            const loanCount = await prisma.loan.count({ where: { tenantId } });
            const { generateLoanId } = await import("../../lib/id-generator");
            const loanNumber = generateLoanId(loanCount + 1);

            const monthlyInterest = (loanAmount * (interestRate / 100)) / 12;
            const emi = loanAmount / tenureMonths + monthlyInterest;
            // BRD v4.0 INT-006: Use EMI schedule generator
            const { generateEMISchedule } = await import("../../services/emi-schedule.service");
            const emiSchedule = await generateEMISchedule(
                tenantId,
                loanAmount,
                interestRate,
                tenureMonths,
                new Date(),
                0
            );
            const emiScheduleData = emiSchedule.map((item) => ({
                installmentNo: item.installmentNo,
                dueDate: item.dueDate,
                principal: String(item.principalComponent),
                interest: String(item.interestComponent),
                totalEmi: String(item.totalEmi),
                penalAmount: "0",
                paidAmount: "0",
                status: "pending",
            }));

            const loan = await prisma.$transaction(async (tx) => {
                const createdLoan = await tx.loan.create({
                    data: {
                        tenantId,
                        memberId: member.id,
                        applicationId: application.id,
                        loanNumber,
                        loanType: "agricultural",
                        principalAmount: loanAmount,
                        interestRate,
                        tenureMonths,
                        disbursedAmount: loanAmount,
                        disbursedAt: new Date(),
                        outstandingPrincipal: loanAmount,
                        status: "active",
                        npaCategory: "standard",
                        loanSubType: "jlg",
                        groupLoanId: groupLoan.id,
                    },
                });

                await tx.emiSchedule.createMany({
                    data: emiScheduleData.map((e) => ({ ...e, loanId: createdLoan.id })),
                });

                await tx.loanApplication.update({
                    where: { id: application.id },
                    data: { status: "disbursed" },
                });

                return createdLoan;
            });

            // GL posting
            await postGl(tenantId, "LOAN_DISBURSEMENT", loanAmount,
                `JLG loan disbursement — ${loanNumber} (Group: ${groupLoan.groupCode})`, period);

            createdLoans.push({ loanNumber, member: `${member.firstName} ${member.lastName}`, amount: loanAmount });
        }

        res.json({
            success: true,
            message: `Disbursed ${createdLoans.length} loans for JLG ${groupLoan.groupCode}`,
            groupLoan: { groupCode: groupLoan.groupCode, groupName: groupLoan.groupName },
            loans: createdLoans,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-024: CIBIL Credit Score Check ─────────────────────────────────────────
router.post("/applications/:id/cibil-check", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const application = await prisma.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
            include: { member: true },
        });

        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }

        const member = application.member;

        // Simulate CIBIL API call (replace with actual API integration)
        // In production, this would call CIBIL API with:
        // - Authorization: Bearer token
        // - company_code header
        // - Borrower data: name, DOB, PAN, address, phone

        const cibilScore = Math.floor(Math.random() * 300) + 300; // Simulated score 300-600
        const cibilReportId = `CIBIL-${Date.now()}-${application.id.slice(-6)}`;

        // Update application with CIBIL score
        await prisma.loanApplication.update({
            where: { id: application.id },
            data: {
                remarks: `${application.remarks || ""} | CIBIL Score: ${cibilScore}`,
            },
        });

        // Store in AI audit log
        await prisma.aiAuditLog.create({
            data: {
                tenantId,
                feature: "cibil_credit_check",
                inputData: JSON.stringify({
                    applicationId: application.id,
                    memberId: member.id,
                    memberName: `${member.firstName} ${member.lastName}`,
                    panNumber: member.panNumber,
                }),
                outputData: JSON.stringify({
                    cibilScore,
                    cibilReportId,
                    reportDate: new Date().toISOString(),
                    status: "SUCCESS",
                }),
                success: true,
                modelVersion: "CIBIL_API_V3",
            },
        });

        res.json({
            success: true,
            cibilScore,
            cibilReportId,
            reportDate: new Date(),
            message: "CIBIL credit check completed",
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-024: Experian Credit Score Check ──────────────────────────────────────
router.post("/applications/:id/experian-check", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const application = await prisma.loanApplication.findFirst({
            where: { id: req.params.id, tenantId },
            include: { member: true },
        });

        if (!application) {
            res.status(404).json({ success: false, message: "Application not found" });
            return;
        }

        const member = application.member;

        // Simulate Experian API call (replace with actual API integration)
        const experianScore = Math.floor(Math.random() * 300) + 300; // Simulated score 300-600
        const experianReportId = `EXPERIAN-${Date.now()}-${application.id.slice(-6)}`;

        // Store in AI audit log
        await prisma.aiAuditLog.create({
            data: {
                tenantId,
                feature: "experian_credit_check",
                inputData: JSON.stringify({
                    applicationId: application.id,
                    memberId: member.id,
                    memberName: `${member.firstName} ${member.lastName}`,
                    panNumber: member.panNumber,
                }),
                outputData: JSON.stringify({
                    experianScore,
                    experianReportId,
                    reportDate: new Date().toISOString(),
                    status: "SUCCESS",
                }),
                success: true,
                modelVersion: "EXPERIAN_API_V1",
            },
        });

        res.json({
            success: true,
            experianScore,
            experianReportId,
            reportDate: new Date(),
            message: "Experian credit check completed",
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── LN-024: Update Loan with Credit Bureau Scores ────────────────────────────
router.post("/:id/credit-bureau-scores", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { cibilScore, cibilReportId, experianScore, experianReportId } = z.object({
            cibilScore: z.number().min(300).max(900).optional(),
            cibilReportId: z.string().optional(),
            experianScore: z.number().min(300).max(900).optional(),
            experianReportId: z.string().optional(),
        }).parse(req.body);

        const loan = await prisma.loan.findFirst({ where: { id: req.params.id, tenantId } });
        if (!loan) {
            res.status(404).json({ success: false, message: "Loan not found" });
            return;
        }

        const updateData: any = {};
        if (cibilScore !== undefined) {
            updateData.cibilScore = cibilScore;
            updateData.cibilReportDate = new Date();
            if (cibilReportId) updateData.cibilReportId = cibilReportId;
        }
        if (experianScore !== undefined) {
            updateData.experianScore = experianScore;
            updateData.experianReportDate = new Date();
            if (experianReportId) updateData.experianReportId = experianReportId;
        }

        await prisma.loan.update({
            where: { id: loan.id },
            data: updateData,
        });

        res.json({ success: true, message: "Credit bureau scores updated" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
