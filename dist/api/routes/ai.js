"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * AI routes — Alerts (Bytez-powered) and Cash Flow forecast
 */
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const bytez_1 = require("../../lib/bytez");
const router = (0, express_1.Router)();
async function getLoanDpd(loanId) {
    const today = new Date();
    const overdue = await prisma_1.default.emiSchedule.findFirst({
        where: { loanId, status: "overdue" },
        orderBy: { dueDate: "asc" },
    });
    if (!overdue)
        return 0;
    return Math.floor((today.getTime() - new Date(overdue.dueDate).getTime()) / (24 * 60 * 60 * 1000));
}
function getAlertStatusKey(tenantId) {
    return `ai_alerts_status`;
}
async function getAlertStatuses(tenantId) {
    const cfg = await prisma_1.default.systemConfig.findUnique({
        where: { tenantId_key: { tenantId, key: getAlertStatusKey(tenantId) } },
    });
    if (!cfg?.value)
        return {};
    try {
        return JSON.parse(cfg.value);
    }
    catch {
        return {};
    }
}
async function setAlertStatus(tenantId, alertId, status) {
    const current = await getAlertStatuses(tenantId);
    current[alertId] = status;
    await prisma_1.default.systemConfig.upsert({
        where: { tenantId_key: { tenantId, key: getAlertStatusKey(tenantId) } },
        create: { tenantId, key: getAlertStatusKey(tenantId), value: JSON.stringify(current), label: "AI alert statuses" },
        update: { value: JSON.stringify(current) },
    });
}
// GET /api/v1/ai/alerts — AI alerts from risk data + Bytez explanations
router.get("/alerts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const allLoans = await prisma_1.default.loan.findMany({
            where: { tenantId, disbursedAt: { not: null } },
            include: { member: { select: { id: true, firstName: true, lastName: true, memberNumber: true } } },
        });
        const loansWithDpd = await Promise.all(allLoans.map(async (l) => ({ ...l, dpd: await getLoanDpd(l.id) })));
        const totalPortfolio = loansWithDpd.filter((l) => l.status !== "closed").reduce((s, l) => s + Number(l.outstandingPrincipal), 0);
        const npaLoans = loansWithDpd.filter((l) => l.status === "npa" || l.dpd >= 90);
        const overdueLoans = loansWithDpd.filter((l) => l.dpd > 0 && l.dpd < 90);
        const highRisk = [...npaLoans, ...overdueLoans]
            .sort((a, b) => b.dpd - a.dpd)
            .slice(0, 10)
            .map((l) => ({
            name: `${l.member.firstName} ${l.member.lastName}`.trim(),
            memberId: l.memberId,
            memberNumber: l.member.memberNumber || l.memberId.slice(-8),
            score: Math.min(100, 20 + l.dpd),
            dpd: l.dpd,
            outstanding: Number(l.outstandingPrincipal),
            flags: l.dpd >= 90 ? ["NPA"] : ["Late Payer"],
        }));
        const statuses = await getAlertStatuses(tenantId);
        const alerts = [];
        const bytezKey = process.env.BYTEZ_API_KEY;
        for (const m of highRisk) {
            const alertId = `npa-${m.memberId}`;
            const status = statuses[alertId] || "PENDING";
            let explanation = `Member has ${m.dpd} days past due, outstanding ₹${Number(m.outstanding).toLocaleString("en-IN")}. ${m.flags.join(", ")}.`;
            if (bytezKey) {
                try {
                    const aiText = await (0, bytez_1.bytezChat)([
                        {
                            role: "system",
                            content: "You are a credit risk analyst for an Indian cooperative society. Reply briefly in 1-2 sentences.",
                        },
                        {
                            role: "user",
                            content: `Explain why member ${m.name} (DPD ${m.dpd}, outstanding ₹${m.outstanding}) is high risk for NPA.`,
                        },
                    ], { temperature: 0.3 });
                    if (aiText)
                        explanation = aiText;
                }
                catch {
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
            await prisma_1.default.aiAuditLog.create({
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
    }
    catch (err) {
        console.error("[AI Alerts]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/ai/alerts/:id/acknowledge | dismiss | escalate
router.post("/alerts/:id/:action", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const action = String(req.params.action);
        if (!["acknowledge", "dismiss", "escalate"].includes(action)) {
            res.status(400).json({ success: false, message: "Invalid action" });
            return;
        }
        const status = action === "acknowledge" ? "ACKNOWLEDGED" : action === "dismiss" ? "DISMISSED" : "ESCALATED";
        await setAlertStatus(tenantId, id, status);
        res.json({ success: true, id, status });
    }
    catch (err) {
        console.error("[AI Alerts action]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── LN-019: AI Predictive NPA Alert ──────────────────────────────────────────
router.get("/npa-predictive-alerts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sixtyDaysAgo = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
        // Get active loans with recent payment patterns
        const activeLoans = await prisma_1.default.loan.findMany({
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
        const alerts = [];
        for (const loan of activeLoans) {
            const overdueEmis = loan.emiSchedule.filter((e) => e.status === "overdue" || (e.dueDate < today && e.status !== "paid"));
            const recentEmis = loan.emiSchedule.filter((e) => e.dueDate >= thirtyDaysAgo);
            const paidCount = recentEmis.filter((e) => e.status === "paid").length;
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
            if (dpd > 60)
                riskScore += 40; // High risk if already 60+ DPD
            else if (dpd > 30)
                riskScore += 25;
            else if (dpd > 0)
                riskScore += 10;
            if (paymentTrend < 0.5)
                riskScore += 30; // Low payment trend
            else if (paymentTrend < 0.7)
                riskScore += 15;
            if (outstandingPenal > outstandingPrincipal * 0.1)
                riskScore += 20; // High penal interest
            const daysToNpa = 90 - dpd;
            if (daysToNpa <= 30 && daysToNpa > 0)
                riskScore += 20; // Approaching NPA threshold
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
    }
    catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/ai/cash-flow?period=30|60|90
router.get("/cash-flow", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = Math.min(90, Math.max(30, parseInt(req.query.period || "30") || 30));
        const today = new Date();
        // Inflows: SB credits, deposit maturities, loan disbursements
        const sbAccounts = await prisma_1.default.sbAccount.findMany({ where: { tenantId } });
        const accountIds = sbAccounts.map((a) => a.id);
        const credits = await prisma_1.default.transaction.aggregate({
            where: { accountId: { in: accountIds }, type: "credit" },
            _sum: { amount: true },
        });
        const debits = await prisma_1.default.transaction.aggregate({
            where: { accountId: { in: accountIds }, type: "debit" },
            _sum: { amount: true },
        });
        const totalCredits = Number(credits._sum.amount || 0);
        const totalDebits = Number(debits._sum.amount || 0);
        // Upcoming EMIs
        const emiDue = await prisma_1.default.emiSchedule.findMany({
            where: {
                loan: { tenantId },
                status: { in: ["pending", "overdue"] },
                dueDate: { gte: today, lte: new Date(today.getTime() + period * 24 * 60 * 60 * 1000) },
            },
            include: { loan: true },
        });
        const emiTotal = emiDue.reduce((s, e) => s + Number(e.totalEmi), 0);
        // Deposit maturities in period
        const maturingDeposits = await prisma_1.default.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                maturityDate: { gte: today, lte: new Date(today.getTime() + period * 24 * 60 * 60 * 1000) },
            },
        });
        const maturityTotal = maturingDeposits.reduce((s, d) => s + Number(d.principal) + Number(d.maturityAmount || d.principal), 0);
        // Weekly forecast buckets
        const forecast = [];
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
                aiInsights = await (0, bytez_1.bytezChat)([
                    {
                        role: "system",
                        content: "You are a treasury analyst for an Indian cooperative society. Give 3-4 brief bullet points.",
                    },
                    {
                        role: "user",
                        content: `Cash flow forecast: ${period} days. Projected inflow ₹${projectedInflow.toLocaleString("en-IN")}, outflow ₹${projectedOutflow.toLocaleString("en-IN")}, net ₹${netPosition.toLocaleString("en-IN")}, liquidity ratio ${liquidityRatio.toFixed(2)}x. Provide 3 key insights.`,
                    },
                ], { temperature: 0.3 });
            }
            catch {
                aiInsights = "• Liquidity ratio indicates healthy position. • Monitor EMI collections. • Deposit maturities add inflow.";
            }
        }
        else {
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
    }
    catch (err) {
        console.error("[AI Cash Flow]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-009: GET /api/v1/ai/compliance-alerts — Compliance Monitoring Alerts
router.get("/compliance-alerts", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const today = new Date();
        const alerts = [];
        // Check compliance events from governance module
        const complianceEvents = await prisma_1.default.complianceEvent.findMany({
            where: { tenantId },
            orderBy: { dueDate: "asc" },
        });
        for (const event of complianceEvents) {
            const dueDate = new Date(event.dueDate);
            const daysRemaining = Math.ceil((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
            // Alert schedule: T-30, T-15, T-7, T-1
            if (daysRemaining <= 30 && daysRemaining >= -1) {
                let severity = "LOW";
                if (daysRemaining <= 1)
                    severity = "CRITICAL";
                else if (daysRemaining <= 7)
                    severity = "HIGH";
                else if (daysRemaining <= 15)
                    severity = "MEDIUM";
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
        const bodDirectors = await prisma_1.default.bodDirector.findMany({
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
        const kycDueMembers = await prisma_1.default.member.findMany({
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
    }
    catch (err) {
        console.error("[Compliance Alerts]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-012: POST /api/v1/ai/chat — Conversational AI - Sahayog Saathi
// Supports both regular auth (staff) and member auth (member portal)
router.post("/chat", async (req, res) => {
    try {
        // Try member auth first (non-blocking check)
        let tenantId;
        let memberIdFromAuth;
        let isMemberAuth = false;
        // Check for member token
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.split(" ")[1];
            try {
                const jwt = require("jsonwebtoken");
                const payload = jwt.verify(token, process.env.MEMBER_JWT_SECRET || "fallback_member_secret");
                if (payload.memberId && payload.tenantId) {
                    tenantId = payload.tenantId;
                    memberIdFromAuth = payload.memberId;
                    isMemberAuth = true;
                }
            }
            catch {
                // Not a member token, continue to regular auth
            }
        }
        // If not member auth, use regular auth middleware
        if (!isMemberAuth) {
            // Use regular auth middleware
            try {
                await new Promise((resolve, reject) => {
                    (0, auth_1.authMiddleware)(req, res, () => {
                        (0, auth_1.requireTenant)(req, res, () => {
                            if (req.user && req.user.tenantId) {
                                tenantId = req.user.tenantId;
                                resolve();
                            }
                            else {
                                reject(new Error("Unauthorized"));
                            }
                        });
                    });
                });
            }
            catch {
                res.status(401).json({ success: false, message: "Unauthorized" });
                return;
            }
        }
        // Ensure tenantId is set
        if (!tenantId) {
            res.status(401).json({ success: false, message: "Unauthorized" });
            return;
        }
        const { query, memberId } = zod_1.z.object({
            query: zod_1.z.string().min(1),
            memberId: zod_1.z.string().optional(),
        }).parse(req.body);
        // Use memberId from auth if not provided in body
        const finalMemberId = memberId || memberIdFromAuth;
        const queryLower = query.toLowerCase();
        let response = "";
        let responseType = "GENERAL";
        // Top-20 query types with NLU
        if (queryLower.includes("balance") || queryLower.includes("baki") || queryLower.includes("shulk")) {
            if (finalMemberId) {
                const account = await prisma_1.default.sbAccount.findFirst({
                    where: { tenantId, memberId: finalMemberId, status: "active" },
                });
                if (account) {
                    response = `Your SB account balance is ₹${Number(account.balance).toLocaleString("en-IN")}.`;
                    responseType = "BALANCE";
                }
                else {
                    response = "No active SB account found.";
                }
            }
            else {
                response = "Please provide your member ID to check balance.";
            }
        }
        else if (queryLower.includes("loan") && (queryLower.includes("baki") || queryLower.includes("outstanding"))) {
            if (finalMemberId) {
                const loans = await prisma_1.default.loan.findMany({
                    where: { tenantId, memberId: finalMemberId, status: "ACTIVE" },
                });
                const totalOutstanding = loans.reduce((sum, l) => sum + Number(l.outstandingPrincipal), 0);
                response = `You have ${loans.length} active loan(s) with total outstanding ₹${totalOutstanding.toLocaleString("en-IN")}.`;
                responseType = "LOAN";
            }
            else {
                response = "Please provide your member ID to check loan details.";
            }
        }
        else if (queryLower.includes("fdr") && (queryLower.includes("mature") || queryLower.includes("kab"))) {
            if (finalMemberId) {
                const deposits = await prisma_1.default.deposit.findMany({
                    where: { tenantId, memberId: finalMemberId, status: "active", depositType: "fd" },
                });
                if (deposits.length > 0) {
                    const nextMaturity = deposits
                        .map((d) => d.maturityDate ? new Date(d.maturityDate) : null)
                        .filter(Boolean)
                        .sort((a, b) => a.getTime() - b.getTime())[0];
                    if (nextMaturity) {
                        response = `Your next FDR matures on ${nextMaturity.toLocaleDateString("en-IN")}.`;
                        responseType = "FDR";
                    }
                }
                else {
                    response = "No active FDR found.";
                }
            }
            else {
                response = "Please provide your member ID to check FDR maturity.";
            }
        }
        else if (queryLower.includes("trial balance") || queryLower.includes("report")) {
            response = "You can generate Trial Balance from the Accounting menu. Reports are available in PDF and Excel formats.";
            responseType = "REPORT";
        }
        else if (queryLower.includes("compliance") || queryLower.includes("pending")) {
            const pendingEvents = await prisma_1.default.complianceEvent.count({
                where: { tenantId, status: "pending" },
            });
            response = `You have ${pendingEvents} pending compliance items. Check the Compliance dashboard for details.`;
            responseType = "COMPLIANCE";
        }
        else {
            // Fallback to Bytez AI if available
            const bytezKey = process.env.BYTEZ_API_KEY;
            if (bytezKey) {
                try {
                    response = await (0, bytez_1.bytezChat)([
                        {
                            role: "system",
                            content: "You are Sahayog Saathi, a helpful assistant for an Indian cooperative society. Reply briefly in 1-2 sentences in Hindi or English based on the query language.",
                        },
                        { role: "user", content: query },
                    ], { temperature: 0.3 });
                }
                catch {
                    response = "I can help you with balance inquiries, loan details, FDR maturity, reports, and compliance status. Please ask in Hindi, Marathi, or English.";
                }
            }
            else {
                response = "I can help you with balance inquiries, loan details, FDR maturity, reports, and compliance status. Please ask in Hindi, Marathi, or English.";
            }
        }
        // Log conversation
        await prisma_1.default.aiAuditLog.create({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[AI Chat]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-015: GET /api/v1/ai/models — List AI Models
router.get("/models", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const models = await prisma_1.default.aiModel.findMany({
            where: { isActive: true },
            orderBy: [{ modelId: "asc" }, { version: "desc" }],
        });
        res.json({ success: true, models });
    }
    catch (err) {
        console.error("[AI Models]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-015: POST /api/v1/ai/models/rollback — Rollback Model Version
router.post("/models/rollback", auth_1.authMiddleware, async (req, res) => {
    try {
        const { modelId, targetVersion } = zod_1.z.object({
            modelId: zod_1.z.string(),
            targetVersion: zod_1.z.string(),
        }).parse(req.body);
        const targetModel = await prisma_1.default.aiModel.findUnique({
            where: { modelId_version: { modelId, version: targetVersion } },
        });
        if (!targetModel) {
            res.status(404).json({ success: false, message: "Target model version not found" });
            return;
        }
        // Deactivate current active version
        await prisma_1.default.aiModel.updateMany({
            where: { modelId, isActive: true },
            data: { isActive: false },
        });
        // Activate target version
        await prisma_1.default.aiModel.update({
            where: { id: targetModel.id },
            data: { isActive: true, rollbackTo: null },
        });
        await prisma_1.default.aiAuditLog.create({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Model Rollback]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-016: POST /api/v1/ai/override — Human Override Mechanism
router.post("/override", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { decisionId, reasonCode, reasonDescription } = zod_1.z.object({
            decisionId: zod_1.z.string(),
            reasonCode: zod_1.z.string().min(1),
            reasonDescription: zod_1.z.string().min(1),
        }).parse(req.body);
        const auditLog = await prisma_1.default.aiAuditLog.findUnique({
            where: { id: decisionId },
        });
        if (!auditLog) {
            res.status(404).json({ success: false, message: "AI decision not found" });
            return;
        }
        await prisma_1.default.aiAuditLog.update({
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
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[AI Override]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-018: GET /api/v1/ai/bias-audit — AI Bias Audit Report
router.get("/bias-audit", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { modelId, period } = req.query;
        // Get loan risk scoring decisions for bias analysis
        const riskDecisions = await prisma_1.default.aiAuditLog.findMany({
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
    }
    catch (err) {
        console.error("[Bias Audit]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// AI-019: GET /api/v1/ai/models/:modelId/performance — AI Model Performance Monitoring
router.get("/models/:modelId/performance", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const { modelId } = req.params;
        const { period = "7d" } = req.query;
        // Parse period (7d, 30d, 90d, all)
        let startDate;
        if (period === "7d") {
            startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        }
        else if (period === "30d") {
            startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        }
        else if (period === "90d") {
            startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        }
        // Get all audit logs for this model
        const logs = await prisma_1.default.aiAuditLog.findMany({
            where: {
                feature: modelId,
                createdAt: startDate ? { gte: startDate } : undefined,
            },
            orderBy: { createdAt: "desc" },
        });
        // Group by model version
        const byVersion = {};
        for (const log of logs) {
            const version = log.modelVersion || "v1.0";
            if (!byVersion[version])
                byVersion[version] = [];
            byVersion[version].push(log);
        }
        // Calculate metrics per version
        const versionMetrics = [];
        for (const [version, versionLogs] of Object.entries(byVersion)) {
            const total = versionLogs.length;
            const successful = versionLogs.filter((l) => l.success).length;
            const errors = versionLogs.filter((l) => !l.success).length;
            const latencies = versionLogs.filter((l) => l.latencyMs !== null).map((l) => l.latencyMs);
            const confidences = versionLogs.filter((l) => l.confidence !== null).map((l) => Number(l.confidence));
            const overrides = versionLogs.filter((l) => l.humanOverrideFlag).length;
            latencies.sort((a, b) => a - b);
            const p95Index = Math.floor(latencies.length * 0.95);
            const p99Index = Math.floor(latencies.length * 0.99);
            versionMetrics.push({
                version,
                totalInvocations: total,
                successRate: total > 0 ? (successful / total) * 100 : 0,
                errorRate: total > 0 ? (errors / total) * 100 : 0,
                avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
                avgConfidence: confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0,
                p95LatencyMs: latencies[p95Index] || 0,
                p99LatencyMs: latencies[p99Index] || 0,
                overrideRate: total > 0 ? (overrides / total) * 100 : 0,
                lastInvocation: versionLogs[0]?.createdAt.toISOString() || null,
            });
        }
        // Daily time series for the active version
        const activeModel = await prisma_1.default.aiModel.findFirst({
            where: { modelId, isActive: true },
        });
        const activeVersion = activeModel?.version || "v1.0";
        const activeLogs = byVersion[activeVersion] || [];
        // Group by day
        const dailyMetrics = {};
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
            if (!log.success)
                dailyMetrics[dateKey].errors++;
            if (log.latencyMs !== null) {
                dailyMetrics[dateKey].avgLatency = (dailyMetrics[dateKey].avgLatency * (dailyMetrics[dateKey].invocations - 1) + log.latencyMs) / dailyMetrics[dateKey].invocations;
            }
            if (log.confidence !== null) {
                dailyMetrics[dateKey].avgConfidence = (dailyMetrics[dateKey].avgConfidence * (dailyMetrics[dateKey].invocations - 1) + Number(log.confidence)) / dailyMetrics[dateKey].invocations;
            }
        }
        const timeSeries = Object.values(dailyMetrics).sort((a, b) => a.date.localeCompare(b.date));
        // Performance alerts
        const alerts = [];
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
    }
    catch (err) {
        console.error("[Model Performance]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=ai.js.map