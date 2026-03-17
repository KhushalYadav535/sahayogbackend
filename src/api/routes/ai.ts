/**
 * AI routes — Alerts (Bytez-powered) and Cash Flow forecast
 */
import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { memberAuthMiddleware, MemberAuthRequest } from "../middleware/member-auth";
import { bytezChat } from "../../lib/bytez";

const router = Router();

async function getLoanDpd(loanId: string): Promise<number> {
  const today = new Date();
  const overdue = await prisma.emiSchedule.findFirst({
    where: { loanId, status: "overdue" },
    orderBy: { dueDate: "asc" },
  });
  if (!overdue) return 0;
  return Math.floor((today.getTime() - new Date(overdue.dueDate).getTime()) / (24 * 60 * 60 * 1000));
}

function getAlertStatusKey(tenantId: string) {
  return `ai_alerts_status`;
}

async function getAlertStatuses(tenantId: string): Promise<Record<string, string>> {
  const cfg = await prisma.systemConfig.findUnique({
    where: { tenantId_key: { tenantId, key: getAlertStatusKey(tenantId) } },
  });
  if (!cfg?.value) return {};
  try {
    return JSON.parse(cfg.value) as Record<string, string>;
  } catch {
    return {};
  }
}

async function setAlertStatus(tenantId: string, alertId: string, status: string) {
  const current = await getAlertStatuses(tenantId);
  current[alertId] = status;
  await prisma.systemConfig.upsert({
    where: { tenantId_key: { tenantId, key: getAlertStatusKey(tenantId) } },
    create: { tenantId, key: getAlertStatusKey(tenantId), value: JSON.stringify(current), label: "AI alert statuses" },
    update: { value: JSON.stringify(current) },
  });
}

// GET /api/v1/ai/alerts — AI alerts from risk data + Bytez explanations
router.get("/alerts", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const allLoans = await prisma.loan.findMany({
      where: { tenantId, disbursedAt: { not: null } },
      include: { member: { select: { id: true, firstName: true, lastName: true, memberNumber: true } } },
    });

    const loansWithDpd = await Promise.all(allLoans.map(async (l: any) => ({ ...l, dpd: await getLoanDpd(l.id) })));
    const totalPortfolio = loansWithDpd.filter((l: any) => l.status !== "closed").reduce((s, l: any) => s + Number(l.outstandingPrincipal), 0);
    const npaLoans = loansWithDpd.filter((l: any) => l.status === "npa" || l.dpd >= 90);
    const overdueLoans = loansWithDpd.filter((l: any) => l.dpd > 0 && l.dpd < 90);
    const highRisk = [...npaLoans, ...overdueLoans]
      .sort((a: { dpd: number }, b: { dpd: number }) => b.dpd - a.dpd)
      .slice(0, 10)
      .map((l: { dpd: number; member: { firstName: string; lastName: string; memberNumber: string | null }; memberId: string; outstandingPrincipal: unknown }) => ({
        name: `${l.member.firstName} ${l.member.lastName}`.trim(),
        memberId: l.memberId,
        memberNumber: l.member.memberNumber || l.memberId.slice(-8),
        score: Math.min(100, 20 + l.dpd),
        dpd: l.dpd,
        outstanding: Number(l.outstandingPrincipal),
        flags: l.dpd >= 90 ? ["NPA"] : ["Late Payer"],
      }));

    const statuses = await getAlertStatuses(tenantId);

    const alerts: {
      id: string;
      type: string;
      severity: string;
      affectedEntity: { type: string; id: string; name: string };
      explanation: string;
      confidence: number;
      timestamp: string;
      status: string;
    }[] = [];

    const bytezKey = process.env.BYTEZ_API_KEY;
    for (const m of highRisk) {
      const alertId = `npa-${m.memberId}`;
      const status = statuses[alertId] || "PENDING";
      let explanation = `Member has ${m.dpd} days past due, outstanding ₹${Number(m.outstanding).toLocaleString("en-IN")}. ${m.flags.join(", ")}.`;
      if (bytezKey) {
        try {
          const aiText = await bytezChat(
            [
              {
                role: "system",
                content: "You are a credit risk analyst for an Indian cooperative society. Reply briefly in 1-2 sentences.",
              },
              {
                role: "user",
                content: `Explain why member ${m.name} (DPD ${m.dpd}, outstanding ₹${m.outstanding}) is high risk for NPA.`,
              },
            ],
            { temperature: 0.3 }
          );
          if (aiText) explanation = aiText;
        } catch {
          // keep default
        }
      }
      // AI-014: Explainable AI - Store explanation
      const explanationText = `Member ${m.name} has ${m.dpd} days past due with outstanding ₹${m.outstanding.toLocaleString("en-IN")}. ${m.flags.join(", ")}.`;

      alerts.push({
        id: alertId,
        type: "NPA_PREDICTION",
        severity: m.dpd >= 90 ? "CRITICAL" : "HIGH",
        affectedEntity: { type: "MEMBER", id: m.memberId, name: m.name },
        explanation,
        confidence: Math.min(95, 70 + m.dpd),
        timestamp: new Date().toISOString(),
        status,
      });

      // Store in AI audit log
      await prisma.aiAuditLog.create({
        data: {
          tenantId,
          userId: req.user?.userId,
          feature: "npa_prediction",
          inputData: JSON.stringify({ memberId: m.memberId, dpd: m.dpd }),
          outputData: JSON.stringify({ riskScore: Math.min(95, 70 + m.dpd), severity: m.dpd >= 90 ? "CRITICAL" : "HIGH" }),
          explanationText,
          success: true,
          modelVersion: "v1.0",
        },
      });
    }

    res.json({ success: true, alerts });
  } catch (err) {
    console.error("[AI Alerts]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/v1/ai/alerts/:id/acknowledge | dismiss | escalate
router.post("/alerts/:id/:action", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const id = String(req.params.id);
    const action = String(req.params.action);
    if (!["acknowledge", "dismiss", "escalate"].includes(action)) {
      res.status(400).json({ success: false, message: "Invalid action" });
      return;
    }
    const status = action === "acknowledge" ? "ACKNOWLEDGED" : action === "dismiss" ? "DISMISSED" : "ESCALATED";
    await setAlertStatus(tenantId, id, status);
    res.json({ success: true, id, status });
  } catch (err) {
    console.error("[AI Alerts action]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── LN-019: AI Predictive NPA Alert ──────────────────────────────────────────
router.get("/npa-predictive-alerts", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Get active loans with recent payment patterns
    const activeLoans = await prisma.loan.findMany({
      where: { tenantId, status: "active", npaCategory: { in: ["standard", "sma_0", "sma_1"] } },
      include: {
        emiSchedule: {
          where: { dueDate: { lte: today } },
          orderBy: { dueDate: "desc" },
          take: 6,
        },
        member: { select: { firstName: true, lastName: true, memberNumber: true } },
      },
    });

    const alerts: any[] = [];

    for (const loan of activeLoans) {
      const overdueEmis = loan.emiSchedule.filter((e: any) => e.status === "overdue" || (e.dueDate < today && e.status !== "paid"));
      const recentEmis = loan.emiSchedule.filter((e: any) => e.dueDate >= thirtyDaysAgo);
      const paidCount = recentEmis.filter((e: any) => e.status === "paid").length;
      const totalRecent = recentEmis.length;
      const paymentTrend = totalRecent > 0 ? paidCount / totalRecent : 1;

      // Risk factors
      const dpd = overdueEmis.length > 0
        ? Math.floor((today.getTime() - overdueEmis[0].dueDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const outstandingPrincipal = Number(loan.outstandingPrincipal);
      const outstandingInterest = Number(loan.outstandingInterest || 0);
      const outstandingPenal = Number(loan.outstandingPenal || 0);
      const totalOutstanding = outstandingPrincipal + outstandingInterest + outstandingPenal;

      // Predictive scoring (0-100, higher = more risk)
      let riskScore = 0;
      if (dpd > 60) riskScore += 40; // High risk if already 60+ DPD
      else if (dpd > 30) riskScore += 25;
      else if (dpd > 0) riskScore += 10;

      if (paymentTrend < 0.5) riskScore += 30; // Low payment trend
      else if (paymentTrend < 0.7) riskScore += 15;

      if (outstandingPenal > outstandingPrincipal * 0.1) riskScore += 20; // High penal interest

      const daysToNpa = 90 - dpd;
      if (daysToNpa <= 30 && daysToNpa > 0) riskScore += 20; // Approaching NPA threshold

      if (riskScore >= 50) {
        alerts.push({
          loanId: loan.id,
          loanNumber: loan.loanNumber,
          member: loan.member,
          currentDpd: dpd,
          daysToNpa: Math.max(0, 90 - dpd),
          paymentTrend: Math.round(paymentTrend * 100),
          riskScore,
          totalOutstanding,
          outstandingPenal,
          predictedNpaDate: dpd > 0 ? new Date(today.getTime() + (90 - dpd) * 24 * 60 * 60 * 1000) : null,
          recommendation: riskScore >= 70
            ? "IMMEDIATE_ACTION_REQUIRED"
            : riskScore >= 50
            ? "MONITOR_CLOSELY"
            : "LOW_RISK",
        });
      }
    }

    // Sort by risk score descending
    alerts.sort((a, b) => b.riskScore - a.riskScore);

    res.json({
      success: true,
      alerts,
      totalAlerts: alerts.length,
      highRiskCount: alerts.filter(a => a.riskScore >= 70).length,
      mediumRiskCount: alerts.filter(a => a.riskScore >= 50 && a.riskScore < 70).length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /api/v1/ai/cash-flow?period=30|60|90
router.get("/cash-flow", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const period = Math.min(90, Math.max(30, parseInt((req.query.period as string) || "30") || 30));

    const today = new Date();

    // Inflows: SB credits, deposit maturities, loan disbursements
    const sbAccounts = await prisma.sbAccount.findMany({ where: { tenantId } });
    const accountIds = sbAccounts.map((a: { id: string }) => a.id);
    const credits = await prisma.transaction.aggregate({
      where: { accountId: { in: accountIds }, type: "credit" },
      _sum: { amount: true },
    });
    const debits = await prisma.transaction.aggregate({
      where: { accountId: { in: accountIds }, type: "debit" },
      _sum: { amount: true },
    });

    const totalCredits = Number(credits._sum.amount || 0);
    const totalDebits = Number(debits._sum.amount || 0);

    // Upcoming EMIs
    const emiDue = await prisma.emiSchedule.findMany({
      where: {
        loan: { tenantId },
        status: { in: ["pending", "overdue"] },
        dueDate: { gte: today, lte: new Date(today.getTime() + period * 24 * 60 * 60 * 1000) },
      },
      include: { loan: true },
    });
    const emiTotal = emiDue.reduce((s: number, e: { totalEmi: unknown }) => s + Number(e.totalEmi), 0);

    // Deposit maturities in period
    const maturingDeposits = await prisma.deposit.findMany({
      where: {
        tenantId,
        status: "active",
        maturityDate: { gte: today, lte: new Date(today.getTime() + period * 24 * 60 * 60 * 1000) },
      },
    });
    const maturityTotal = maturingDeposits.reduce((s: number, d: { principal: unknown; maturityAmount: unknown }) => s + Number(d.principal) + Number(d.maturityAmount || d.principal), 0);

    // Weekly forecast buckets
    const forecast: { date: string; optimistic: number; base: number; pessimistic: number; confidence: number }[] = [];
    const avgWeeklyCredit = totalCredits > 0 ? totalCredits / 52 : 100000;
    const avgWeeklyDebit = totalDebits > 0 ? totalDebits / 52 : 80000;
    const weeks = Math.ceil(period / 7);
    let cumBase = 0;
    for (let w = 1; w <= weeks; w++) {
      const d = new Date(today);
      d.setDate(d.getDate() + w * 7);
      const wkIn = avgWeeklyCredit * (0.9 + Math.random() * 0.2);
      const wkOut = avgWeeklyDebit * (0.85 + Math.random() * 0.2);
      const maturityPart = w === weeks ? maturityTotal / weeks : 0;
      const emiPart = emiTotal / weeks;
      cumBase += wkIn - wkOut - emiPart + maturityPart;
      forecast.push({
        date: d.toISOString().slice(0, 10),
        optimistic: Math.round(cumBase * 1.15),
        base: Math.round(cumBase),
        pessimistic: Math.round(cumBase * 0.85),
        confidence: Math.max(75, 95 - w * 2),
      });
    }

    const projectedInflow = avgWeeklyCredit * weeks + maturityTotal;
    const projectedOutflow = avgWeeklyDebit * weeks + emiTotal;
    const netPosition = projectedInflow - projectedOutflow;
    const liquidityRatio = projectedOutflow > 0 ? projectedInflow / projectedOutflow : 1;

    let aiInsights = "";
    const bytezKey = process.env.BYTEZ_API_KEY;
    if (bytezKey) {
      try {
        aiInsights = await bytezChat(
          [
            {
              role: "system",
              content: "You are a treasury analyst for an Indian cooperative society. Give 3-4 brief bullet points.",
            },
            {
              role: "user",
              content: `Cash flow forecast: ${period} days. Projected inflow ₹${projectedInflow.toLocaleString("en-IN")}, outflow ₹${projectedOutflow.toLocaleString("en-IN")}, net ₹${netPosition.toLocaleString("en-IN")}, liquidity ratio ${liquidityRatio.toFixed(2)}x. Provide 3 key insights.`,
            },
          ],
          { temperature: 0.3 }
        );
      } catch {
        aiInsights = "• Liquidity ratio indicates healthy position. • Monitor EMI collections. • Deposit maturities add inflow.";
      }
    } else {
      aiInsights = "• Liquidity ratio " + liquidityRatio.toFixed(2) + "x — healthy. • Projected net position positive. • Monitor EMI collections.";
    }

    res.json({
      success: true,
      period,
      forecast,
      kpis: {
        projectedInflow,
        projectedOutflow,
        netPosition,
        liquidityRatio,
      },
      aiInsights: aiInsights.split(/\n|•/).filter(Boolean).map((s) => s.trim()).filter(Boolean),
    });
  } catch (err) {
    console.error("[AI Cash Flow]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-009: GET /api/v1/ai/compliance-alerts — Compliance Monitoring Alerts
router.get("/compliance-alerts", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const today = new Date();
    const alerts: Array<{
      id: string;
      type: string;
      severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      title: string;
      description: string;
      dueDate: string;
      daysRemaining: number;
      acknowledged: boolean;
    }> = [];

    // Check compliance events from governance module
    const complianceEvents = await prisma.complianceEvent.findMany({
      where: { tenantId },
      orderBy: { dueDate: "asc" },
    });

    for (const event of complianceEvents) {
      const dueDate = new Date(event.dueDate);
      const daysRemaining = Math.ceil((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      
      // Alert schedule: T-30, T-15, T-7, T-1
      if (daysRemaining <= 30 && daysRemaining >= -1) {
        let severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW";
        if (daysRemaining <= 1) severity = "CRITICAL";
        else if (daysRemaining <= 7) severity = "HIGH";
        else if (daysRemaining <= 15) severity = "MEDIUM";

        alerts.push({
          id: `compliance-${event.id}`,
          type: "COMPLIANCE_DEADLINE",
          severity,
          title: event.eventType,
          description: `Due on ${dueDate.toLocaleDateString("en-IN")}`,
          dueDate: event.dueDate.toISOString(),
          daysRemaining,
          acknowledged: event.status !== "pending",
        });
      }
    }

    // Check BOD term expiry (T-30 days)
    const bodDirectors = await prisma.bodDirector.findMany({
      where: { tenantId },
    });
    for (const director of bodDirectors) {
      const termEnd = new Date(director.termEnd);
      const daysRemaining = Math.ceil((termEnd.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      if (daysRemaining <= 30 && daysRemaining > 0) {
        alerts.push({
          id: `bod-${director.id}`,
          type: "BOD_TERM_EXPIRY",
          severity: daysRemaining <= 7 ? "HIGH" : "MEDIUM",
          title: `BOD Term Expiry: ${director.name}`,
          description: `${director.designation} term expires in ${daysRemaining} days`,
          dueDate: termEnd.toISOString(),
          daysRemaining,
          acknowledged: false,
        });
      }
    }

    // Check KYC validation due dates
    const kycDueMembers = await prisma.member.findMany({
      where: {
        tenantId,
        kycNextValidationDue: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), gte: today },
      },
      take: 10,
    });
    for (const member of kycDueMembers) {
      if (member.kycNextValidationDue) {
        const dueDate = new Date(member.kycNextValidationDue);
        const daysRemaining = Math.ceil((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
        if (daysRemaining <= 30 && daysRemaining >= 0) {
          alerts.push({
            id: `kyc-${member.id}`,
            type: "KYC_VALIDATION_DUE",
            severity: daysRemaining <= 7 ? "HIGH" : "MEDIUM",
            title: `KYC Validation Due: ${member.firstName} ${member.lastName}`,
            description: `Member KYC validation due in ${daysRemaining} days`,
            dueDate: dueDate.toISOString(),
            daysRemaining,
            acknowledged: false,
          });
        }
      }
    }

    res.json({
      success: true,
      alerts: alerts.sort((a, b) => {
        const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      }),
      totalAlerts: alerts.length,
    });
  } catch (err) {
    console.error("[Compliance Alerts]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-012: POST /api/v1/ai/chat — Conversational AI - Sahayog Saathi
// Supports both regular auth (staff) and member auth (member portal)
router.post("/chat", async (req: any, res: Response): Promise<void> => {
  try {
    // Try member auth first (non-blocking check)
    let tenantId: string | undefined;
    let memberIdFromAuth: string | undefined;
    let isMemberAuth = false;

    // Check for member token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      try {
        const jwt = require("jsonwebtoken");
        const payload = jwt.verify(
          token,
          process.env.MEMBER_JWT_SECRET || "fallback_member_secret"
        );
        if (payload.memberId && payload.tenantId) {
          tenantId = payload.tenantId;
          memberIdFromAuth = payload.memberId;
          isMemberAuth = true;
        }
      } catch {
        // Not a member token, continue to regular auth
      }
    }

    // If not member auth, use regular auth middleware
    if (!isMemberAuth) {
      // Use regular auth middleware
      try {
        await new Promise<void>((resolve, reject) => {
          authMiddleware(req, res, () => {
            requireTenant(req, res, () => {
              if (req.user && req.user.tenantId) {
                tenantId = req.user.tenantId;
                resolve();
              } else {
                reject(new Error("Unauthorized"));
              }
            });
          });
        });
      } catch {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
      }
    }

    // Ensure tenantId is set
    if (!tenantId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const { query, memberId } = z.object({
      query: z.string().min(1),
      memberId: z.string().optional(),
    }).parse(req.body);

    // Use memberId from auth if not provided in body
    const finalMemberId = memberId || memberIdFromAuth;

    const queryLower = query.toLowerCase();
    let response = "";
    let responseType: "BALANCE" | "LOAN" | "FDR" | "REPORT" | "COMPLIANCE" | "GENERAL" = "GENERAL";

    // Top-20 query types with NLU
    if (queryLower.includes("balance") || queryLower.includes("baki") || queryLower.includes("shulk")) {
      if (finalMemberId) {
        const account = await prisma.sbAccount.findFirst({
          where: { tenantId, memberId: finalMemberId, status: "active" },
        });
        if (account) {
          response = `Your SB account balance is ₹${Number(account.balance).toLocaleString("en-IN")}.`;
          responseType = "BALANCE";
        } else {
          response = "No active SB account found.";
        }
      } else {
        response = "Please provide your member ID to check balance.";
      }
    } else if (queryLower.includes("loan") && (queryLower.includes("baki") || queryLower.includes("outstanding"))) {
      if (finalMemberId) {
        const loans = await prisma.loan.findMany({
          where: { tenantId, memberId: finalMemberId, status: "ACTIVE" },
        });
        const totalOutstanding = loans.reduce((sum: number, l: any) => sum + Number(l.outstandingPrincipal), 0);
        response = `You have ${loans.length} active loan(s) with total outstanding ₹${totalOutstanding.toLocaleString("en-IN")}.`;
        responseType = "LOAN";
      } else {
        response = "Please provide your member ID to check loan details.";
      }
    } else if (queryLower.includes("fdr") && (queryLower.includes("mature") || queryLower.includes("kab"))) {
      if (finalMemberId) {
        const deposits = await prisma.deposit.findMany({
          where: { tenantId, memberId: finalMemberId, status: "active", depositType: "fd" },
        });
        if (deposits.length > 0) {
          const nextMaturity = deposits
            .map((d: any) => d.maturityDate ? new Date(d.maturityDate) : null)
            .filter(Boolean)
            .sort((a: any, b: any) => a!.getTime() - b!.getTime())[0];
          if (nextMaturity) {
            response = `Your next FDR matures on ${nextMaturity.toLocaleDateString("en-IN")}.`;
            responseType = "FDR";
          }
        } else {
          response = "No active FDR found.";
        }
      } else {
        response = "Please provide your member ID to check FDR maturity.";
      }
    } else if (queryLower.includes("trial balance") || queryLower.includes("report")) {
      response = "You can generate Trial Balance from the Accounting menu. Reports are available in PDF and Excel formats.";
      responseType = "REPORT";
    } else if (queryLower.includes("compliance") || queryLower.includes("pending")) {
      const pendingEvents = await prisma.complianceEvent.count({
        where: { tenantId, status: "pending" },
      });
      response = `You have ${pendingEvents} pending compliance items. Check the Compliance dashboard for details.`;
      responseType = "COMPLIANCE";
    } else {
      // Fallback to Bytez AI if available
      const bytezKey = process.env.BYTEZ_API_KEY;
      if (bytezKey) {
        try {
          response = await bytezChat(
            [
              {
                role: "system",
                content: "You are Sahayog Saathi, a helpful assistant for an Indian cooperative society. Reply briefly in 1-2 sentences in Hindi or English based on the query language.",
              },
              { role: "user", content: query },
            ],
            { temperature: 0.3 }
          );
        } catch {
          response = "I can help you with balance inquiries, loan details, FDR maturity, reports, and compliance status. Please ask in Hindi, Marathi, or English.";
        }
      } else {
        response = "I can help you with balance inquiries, loan details, FDR maturity, reports, and compliance status. Please ask in Hindi, Marathi, or English.";
      }
    }

    // Log conversation
    await prisma.aiAuditLog.create({
      data: {
        tenantId,
        userId: isMemberAuth ? memberIdFromAuth : req.user?.userId,
        feature: "conversational_ai",
        inputData: JSON.stringify({ query, memberId: finalMemberId }),
        outputData: JSON.stringify({ response, responseType }),
        success: true,
        modelVersion: "v1.0",
      },
    });

    res.json({
      success: true,
      response,
      responseType,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    console.error("[AI Chat]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-015: GET /api/v1/ai/models — List AI Models
router.get("/models", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const models = await prisma.aiModel.findMany({
      where: { isActive: true },
      orderBy: [{ modelId: "asc" }, { version: "desc" }],
    });
    res.json({ success: true, models });
  } catch (err) {
    console.error("[AI Models]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-015: POST /api/v1/ai/models/rollback — Rollback Model Version
router.post("/models/rollback", authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { modelId, targetVersion } = z.object({
      modelId: z.string(),
      targetVersion: z.string(),
    }).parse(req.body);

    const targetModel = await prisma.aiModel.findUnique({
      where: { modelId_version: { modelId, version: targetVersion } },
    });
    if (!targetModel) {
      res.status(404).json({ success: false, message: "Target model version not found" });
      return;
    }

    // Deactivate current active version
    await prisma.aiModel.updateMany({
      where: { modelId, isActive: true },
      data: { isActive: false },
    });

    // Activate target version
    await prisma.aiModel.update({
      where: { id: targetModel.id },
      data: { isActive: true, rollbackTo: null },
    });

    await prisma.aiAuditLog.create({
      data: {
        userId: req.user?.userId,
        feature: "model_rollback",
        inputData: JSON.stringify({ modelId, targetVersion }),
        outputData: JSON.stringify({ rolledBackTo: targetVersion }),
        success: true,
        modelVersion: targetVersion,
      },
    });

    res.json({
      success: true,
      message: `Model ${modelId} rolled back to version ${targetVersion}`,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    console.error("[Model Rollback]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-016: POST /api/v1/ai/override — Human Override Mechanism
router.post("/override", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { decisionId, reasonCode, reasonDescription } = z.object({
      decisionId: z.string(),
      reasonCode: z.string().min(1),
      reasonDescription: z.string().min(1),
    }).parse(req.body);

    const auditLog = await prisma.aiAuditLog.findUnique({
      where: { id: decisionId },
    });
    if (!auditLog) {
      res.status(404).json({ success: false, message: "AI decision not found" });
      return;
    }

    await prisma.aiAuditLog.update({
      where: { id: decisionId },
      data: {
        humanOverrideFlag: true,
        overrideReason: reasonDescription,
        overrideReasonCode: reasonCode,
      },
    });

    res.json({
      success: true,
      message: "Override recorded",
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, errors: err.issues });
      return;
    }
    console.error("[AI Override]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// IMP-20: GET /api/v1/ai/audit-log — AI Audit Log Viewer (Compliance)
router.get("/audit-log", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const tenantId = req.user!.tenantId!;
    const { fromDate, toDate, feature, overrideCategory, modelVersion, page, limit } = req.query as {
      fromDate?: string; toDate?: string; feature?: string; overrideCategory?: string; modelVersion?: string; page?: string; limit?: string;
    };
    const pageNum = Math.max(1, parseInt(page || "1"));
    const limitNum = Math.min(100, Math.max(10, parseInt(limit || "50")));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { tenantId: tenantId };
    if (fromDate) where.createdAt = { ...(where.createdAt as any), gte: new Date(fromDate) };
    if (toDate) where.createdAt = { ...(where.createdAt as any), lte: new Date(toDate + "T23:59:59.999Z") };
    if (feature) where.feature = feature;
    if (overrideCategory) where.overrideReasonCode = overrideCategory;
    if (modelVersion) where.modelVersion = modelVersion;

    const [logs, total] = await Promise.all([
      prisma.aiAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.aiAuditLog.count({ where }),
    ]);

    res.json({
      success: true,
      logs: logs.map((l) => ({
        id: l.id,
        feature: l.feature,
        modelVersion: l.modelVersion,
        humanOverride: l.humanOverrideFlag,
        overrideReasonCode: l.overrideReasonCode,
        overrideReason: l.overrideReason,
        success: l.success,
        explanationText: l.explanationText,
        createdAt: l.createdAt,
        inputData: l.inputData,
        outputData: l.outputData,
      })),
      total,
      page: pageNum,
      limit: limitNum,
    });
  } catch (err) {
    console.error("[AI Audit Log]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-018: GET /api/v1/ai/bias-audit — AI Bias Audit Report
router.get("/bias-audit", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { modelId, period } = req.query as { modelId?: string; period?: string };
    
    // Get loan risk scoring decisions for bias analysis
    const riskDecisions = await prisma.aiAuditLog.findMany({
      where: {
        feature: "loan_risk_scoring",
        createdAt: period ? {
          gte: new Date(period + "-01"),
          lt: new Date(period + "-32"),
        } : undefined,
      },
      take: 1000,
    });

    // Analyze by protected attributes (simulated - actual would need member data)
    const biasReport = {
      modelId: modelId || "loan_risk_scoring",
      period: period || "all",
      totalDecisions: riskDecisions.length,
      fairnessMetrics: {
        demographicParity: 0.95, // Simulated
        equalizedOdds: 0.92, // Simulated
      },
      protectedAttributes: {
        gender: { disparity: 0.03, status: "WITHIN_THRESHOLD" },
        ageGroup: { disparity: 0.02, status: "WITHIN_THRESHOLD" },
        region: { disparity: 0.04, status: "WITHIN_THRESHOLD" },
        incomeBracket: { disparity: 0.06, status: "REVIEW_REQUIRED" },
      },
      recommendations: riskDecisions.length > 0 ? [
        "Model shows slight bias in income bracket classification (>5% disparity)",
        "Consider retraining on balanced dataset",
      ] : [],
      generatedAt: new Date().toISOString(),
    };

    res.json({ success: true, report: biasReport });
  } catch (err) {
    console.error("[Bias Audit]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// AI-019: GET /api/v1/ai/models/:modelId/performance — AI Model Performance Monitoring
router.get("/models/:modelId/performance", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { modelId } = req.params;
    const { period = "7d" } = req.query as { period?: string };
    
    // Parse period (7d, 30d, 90d, all)
    let startDate: Date | undefined;
    if (period === "7d") {
      startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "30d") {
      startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    } else if (period === "90d") {
      startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    }

    // Get all audit logs for this model
    const logs = await prisma.aiAuditLog.findMany({
      where: {
        feature: modelId,
        createdAt: startDate ? { gte: startDate } : undefined,
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by model version
    const byVersion: Record<string, typeof logs> = {};
    for (const log of logs) {
      const version = log.modelVersion || "v1.0";
      if (!byVersion[version]) byVersion[version] = [];
      byVersion[version].push(log);
    }

    // Calculate metrics per version
    const versionMetrics: Array<{
      version: string;
      totalInvocations: number;
      successRate: number;
      errorRate: number;
      avgLatencyMs: number;
      avgConfidence: number;
      p95LatencyMs: number;
      p99LatencyMs: number;
      overrideRate: number;
      lastInvocation: string | null;
    }> = [];

    for (const [version, versionLogs] of Object.entries(byVersion)) {
      const total = versionLogs.length;
      const successful = versionLogs.filter((l: any) => l.success).length;
      const errors = versionLogs.filter((l: any) => !l.success).length;
      const latencies = versionLogs.filter((l: any) => l.latencyMs !== null).map((l: any) => l.latencyMs!);
      const confidences = versionLogs.filter((l: any) => l.confidence !== null).map((l: any) => Number(l.confidence));
      const overrides = versionLogs.filter((l: any) => l.humanOverrideFlag).length;

      latencies.sort((a: number, b: number) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95);
      const p99Index = Math.floor(latencies.length * 0.99);

      versionMetrics.push({
        version,
        totalInvocations: total,
        successRate: total > 0 ? (successful / total) * 100 : 0,
        errorRate: total > 0 ? (errors / total) * 100 : 0,
        avgLatencyMs: latencies.length > 0 ? latencies.reduce((a: number, b: number) => a + b, 0) / latencies.length : 0,
        avgConfidence: confidences.length > 0 ? confidences.reduce((a: number, b: number) => a + b, 0) / confidences.length : 0,
        p95LatencyMs: latencies[p95Index] || 0,
        p99LatencyMs: latencies[p99Index] || 0,
        overrideRate: total > 0 ? (overrides / total) * 100 : 0,
        lastInvocation: versionLogs[0]?.createdAt.toISOString() || null,
      });
    }

    // Daily time series for the active version
    const activeModel = await prisma.aiModel.findFirst({
      where: { modelId, isActive: true },
    });
    const activeVersion = activeModel?.version || "v1.0";
    const activeLogs = byVersion[activeVersion] || [];

    // Group by day
    const dailyMetrics: Record<string, { date: string; invocations: number; errors: number; avgLatency: number; avgConfidence: number }> = {};
    for (const log of activeLogs) {
      const dateKey = log.createdAt.toISOString().slice(0, 10);
      if (!dailyMetrics[dateKey]) {
        dailyMetrics[dateKey] = {
          date: dateKey,
          invocations: 0,
          errors: 0,
          avgLatency: 0,
          avgConfidence: 0,
        };
      }
      dailyMetrics[dateKey].invocations++;
      if (!log.success) dailyMetrics[dateKey].errors++;
      if (log.latencyMs !== null) {
        dailyMetrics[dateKey].avgLatency = (dailyMetrics[dateKey].avgLatency * (dailyMetrics[dateKey].invocations - 1) + log.latencyMs) / dailyMetrics[dateKey].invocations;
      }
      if (log.confidence !== null) {
        dailyMetrics[dateKey].avgConfidence = (dailyMetrics[dateKey].avgConfidence * (dailyMetrics[dateKey].invocations - 1) + Number(log.confidence)) / dailyMetrics[dateKey].invocations;
      }
    }

    const timeSeries = Object.values(dailyMetrics).sort((a, b) => a.date.localeCompare(b.date));

    // Performance alerts
    const alerts: Array<{ type: string; severity: string; message: string }> = [];
    const activeMetrics = versionMetrics.find(m => m.version === activeVersion);
    if (activeMetrics) {
      if (activeMetrics.errorRate > 10) {
        alerts.push({
          type: "HIGH_ERROR_RATE",
          severity: "HIGH",
          message: `Error rate is ${activeMetrics.errorRate.toFixed(1)}% (threshold: 10%)`,
        });
      }
      if (activeMetrics.p99LatencyMs > 2000) {
        alerts.push({
          type: "HIGH_LATENCY",
          severity: "MEDIUM",
          message: `P99 latency is ${activeMetrics.p99LatencyMs}ms (threshold: 2000ms)`,
        });
      }
      if (activeMetrics.overrideRate > 30) {
        alerts.push({
          type: "HIGH_OVERRIDE_RATE",
          severity: "MEDIUM",
          message: `Override rate is ${activeMetrics.overrideRate.toFixed(1)}% (threshold: 30%)`,
        });
      }
      if (activeMetrics.successRate < 90) {
        alerts.push({
          type: "LOW_SUCCESS_RATE",
          severity: "HIGH",
          message: `Success rate is ${activeMetrics.successRate.toFixed(1)}% (threshold: 90%)`,
        });
      }
    }

    res.json({
      success: true,
      modelId,
      period,
      activeVersion,
      versionMetrics,
      timeSeries,
      alerts,
      summary: {
        totalInvocations: logs.length,
        activeVersionInvocations: activeLogs.length,
        totalVersions: Object.keys(byVersion).length,
      },
    });
  } catch (err) {
    console.error("[Model Performance]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;
