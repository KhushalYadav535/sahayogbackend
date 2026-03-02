/**
 * AI routes — Alerts (Bytez-powered) and Cash Flow forecast
 */
import { Router, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
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

export default router;
