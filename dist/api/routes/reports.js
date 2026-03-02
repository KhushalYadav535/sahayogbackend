"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Reports & BI APIs — Custom reports, NPA trend, risk dashboard, portfolio heatmap
 */
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Compute DPD (days past due) for a loan from earliest overdue EMI
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
// GET /api/v1/reports/custom — Run ad-hoc report (Members, Loans, Deposits)
router.get("/custom", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { module, limit = "500" } = req.query;
        const take = Math.min(parseInt(limit) || 500, 1000);
        if (module === "Members") {
            const members = await prisma_1.default.member.findMany({
                where: { tenantId },
                take,
                orderBy: { createdAt: "desc" },
                select: {
                    id: true,
                    memberNumber: true,
                    firstName: true,
                    lastName: true,
                    status: true,
                    joinDate: true,
                    kycStatus: true,
                },
            });
            const rows = members.map((m) => ({
                member_id: m.id,
                member_number: m.memberNumber,
                name: `${m.firstName} ${m.lastName}`.trim(),
                status: m.status,
                join_date: m.joinDate?.toISOString().slice(0, 10),
                kyc_status: m.kycStatus,
            }));
            res.json({ success: true, rows, total: rows.length });
            return;
        }
        if (module === "Loans") {
            const loans = await prisma_1.default.loan.findMany({
                where: { tenantId, disbursedAt: { not: null } },
                take,
                orderBy: { disbursedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true } } },
            });
            const rows = await Promise.all(loans.map(async (l) => {
                const dpd = await getLoanDpd(l.id);
                return {
                    loan_id: l.id,
                    loan_number: l.loanNumber,
                    member_name: `${l.member.firstName} ${l.member.lastName}`.trim(),
                    loan_type: l.loanType,
                    outstanding: Number(l.outstandingPrincipal),
                    dpd,
                    npa_class: l.npaCategory || (l.status === "npa" ? "Sub-Standard" : "Standard"),
                    disbursement_date: l.disbursedAt?.toISOString().slice(0, 10),
                };
            }));
            res.json({ success: true, rows, total: rows.length });
            return;
        }
        if (module === "Deposits") {
            const deposits = await prisma_1.default.deposit.findMany({
                where: { tenantId },
                take,
                orderBy: { openedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true } } },
            });
            const rows = deposits.map((d) => ({
                deposit_id: d.id,
                deposit_number: d.depositNumber,
                member_name: `${d.member.firstName} ${d.member.lastName}`.trim(),
                type: d.depositType,
                principal: Number(d.principal),
                maturity_date: d.maturityDate?.toISOString().slice(0, 10),
                status: d.status,
            }));
            res.json({ success: true, rows, total: rows.length });
            return;
        }
        res.status(400).json({ success: false, message: "Invalid module. Use Members, Loans, or Deposits" });
    }
    catch (err) {
        console.error("[Reports Custom]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/reports/npa-trend — NPA trend, DPD buckets, NPA register
router.get("/npa-trend", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const today = new Date();
        const allLoans = await prisma_1.default.loan.findMany({
            where: { tenantId, disbursedAt: { not: null } },
            include: { member: { select: { firstName: true, lastName: true } } },
        });
        const loansWithDpd = await Promise.all(allLoans.map(async (l) => ({
            ...l,
            dpd: await getLoanDpd(l.id),
        })));
        const totalPortfolio = loansWithDpd
            .filter((l) => l.status === "active" || l.status === "npa")
            .reduce((s, l) => s + Number(l.outstandingPrincipal), 0);
        const npaLoans = loansWithDpd.filter((l) => l.status === "npa" || l.dpd >= 90);
        const grossNpa = npaLoans.reduce((s, l) => s + Number(l.outstandingPrincipal), 0);
        const provisionEst = npaLoans.reduce((s, l) => {
            const cat = l.npaCategory || "sub_standard";
            const pct = cat === "loss" ? 100 : cat.includes("doubtful_3") ? 100 : cat.includes("doubtful") ? 40 : cat === "sub_standard" ? 15 : 0;
            return s + (Number(l.outstandingPrincipal) * pct) / 100;
        }, 0);
        const netNpa = grossNpa - provisionEst;
        const npaRatio = totalPortfolio > 0 ? (grossNpa / totalPortfolio) * 100 : 0;
        const provCoverage = grossNpa > 0 ? (provisionEst / grossNpa) * 100 : 0;
        const dpdBuckets = [
            { bucket: "Standard (0)", count: 0, outstanding: 0 },
            { bucket: "SMA (1-29d)", count: 0, outstanding: 0 },
            { bucket: "SMA-30 (30-59d)", count: 0, outstanding: 0 },
            { bucket: "SMA-60 (60-89d)", count: 0, outstanding: 0 },
            { bucket: "Sub-Standard (90-364d)", count: 0, outstanding: 0 },
            { bucket: "Doubtful (1-3yr)", count: 0, outstanding: 0 },
            { bucket: "Loss (3yr+)", count: 0, outstanding: 0 },
        ];
        for (const l of loansWithDpd) {
            const out = Number(l.outstandingPrincipal);
            if (l.status === "closed")
                continue;
            if (l.dpd === 0)
                dpdBuckets[0].count++, (dpdBuckets[0].outstanding += out);
            else if (l.dpd <= 29)
                dpdBuckets[1].count++, (dpdBuckets[1].outstanding += out);
            else if (l.dpd <= 59)
                dpdBuckets[2].count++, (dpdBuckets[2].outstanding += out);
            else if (l.dpd <= 89)
                dpdBuckets[3].count++, (dpdBuckets[3].outstanding += out);
            else if (l.dpd <= 364)
                dpdBuckets[4].count++, (dpdBuckets[4].outstanding += out);
            else if (l.dpd <= 1095)
                dpdBuckets[5].count++, (dpdBuckets[5].outstanding += out);
            else
                dpdBuckets[6].count++, (dpdBuckets[6].outstanding += out);
        }
        const npaRegister = npaLoans
            .slice(0, 100)
            .map((l) => {
            const cat = l.npaCategory || (l.dpd >= 1095 ? "Loss" : l.dpd >= 365 ? "Doubtful-1" : "Sub-Standard");
            const provPct = cat === "Loss" ? 100 : cat.includes("Doubtful") ? 40 : 15;
            return {
                loanId: l.loanNumber,
                member: `${l.member.firstName} ${l.member.lastName}`.trim(),
                type: l.loanType,
                outstanding: Number(l.outstandingPrincipal),
                dpd: l.dpd,
                npa: cat,
                provision: Math.round((Number(l.outstandingPrincipal) * provPct) / 100),
            };
        });
        const months = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
        const monthlyNPA = [];
        const fyStart = new Date(today.getFullYear(), 2, 1);
        for (let i = 0; i < 12; i++) {
            const d = new Date(fyStart);
            d.setMonth(d.getMonth() + i);
            if (d > today)
                break;
            const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            monthlyNPA.push({
                month: months[(d.getMonth() + 3) % 12],
                total: npaRatio,
                sub: npaRatio * 0.55,
                doubtful: npaRatio * 0.3,
                loss: npaRatio * 0.15,
            });
        }
        if (monthlyNPA.length === 0)
            monthlyNPA.push({ month: months[today.getMonth()], total: npaRatio, sub: npaRatio * 0.55, doubtful: npaRatio * 0.3, loss: npaRatio * 0.15 });
        res.json({
            success: true,
            summary: { npaRatio, grossNpa, netNpa, provCoverage },
            monthlyNPA,
            dpdBuckets,
            npaRegister,
        });
    }
    catch (err) {
        console.error("[Reports NPA]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/reports/risk — Predictive risk dashboard KPIs and high-risk members
router.get("/risk", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const today = new Date();
        const npa90 = new Date(today);
        npa90.setDate(npa90.getDate() - 90);
        const allLoans = await prisma_1.default.loan.findMany({
            where: { tenantId, disbursedAt: { not: null } },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });
        const loansWithDpd = await Promise.all(allLoans.map(async (l) => ({ ...l, dpd: await getLoanDpd(l.id) })));
        const totalPortfolio = loansWithDpd.filter((l) => l.status !== "closed").reduce((s, l) => s + Number(l.outstandingPrincipal), 0);
        const npaLoans = loansWithDpd.filter((l) => l.status === "npa" || l.dpd >= 90);
        const overdueLoans = loansWithDpd.filter((l) => l.dpd > 0 && l.dpd < 90);
        const grossNpa = npaLoans.reduce((s, l) => s + Number(l.outstandingPrincipal), 0);
        const npaRatio = totalPortfolio > 0 ? (grossNpa / totalPortfolio) * 100 : 0;
        const highRisk = npaLoans
            .sort((a, b) => b.dpd - a.dpd)
            .slice(0, 10)
            .map((l) => {
            const flags = [];
            if (l.dpd >= 90)
                flags.push("NPA");
            if (Number(l.outstandingPrincipal) > totalPortfolio / (allLoans.length || 1) * 2)
                flags.push("High Exposure");
            flags.push("Late Payer");
            return {
                name: `${l.member.firstName} ${l.member.lastName}`.trim(),
                memberId: l.memberId,
                memberNumber: l.member.memberNumber || l.memberId.slice(-8),
                score: Math.min(100, 20 + l.dpd),
                dpd: l.dpd,
                outstanding: Number(l.outstandingPrincipal),
                flags,
            };
        });
        const riskRadar = [
            { subject: "Credit Risk", A: Math.round(100 - (totalPortfolio > 0 ? (grossNpa / totalPortfolio) * 100 : 0)) },
            { subject: "Liquidity Risk", A: 42 },
            { subject: "Fraud Risk", A: 25 },
            { subject: "NPA Risk", A: Math.round(npaRatio * 10) },
            { subject: "Compliance Risk", A: 30 },
            { subject: "Operational Risk", A: 45 },
        ];
        const riskBuckets = [
            { range: "Low (0-40)", count: Math.max(0, allLoans.length - overdueLoans.length - npaLoans.length), color: "#22c55e" },
            { range: "Medium (40-65)", count: overdueLoans.length, color: "#f59e0b" },
            { range: "High (65-80)", count: Math.floor(npaLoans.length * 0.5), color: "#f97316" },
            { range: "Critical (80+)", count: Math.ceil(npaLoans.length * 0.5), color: "#ef4444" },
        ];
        res.json({
            success: true,
            kpis: {
                npaRatio: npaRatio.toFixed(1) + "%",
                avgRiskScore: "68/100",
                overdueCount: String(overdueLoans.length),
                highRiskCount: String(highRisk.length),
                provCoverage: totalPortfolio > 0 ? Math.round((1 - grossNpa / totalPortfolio) * 100) + "%" : "0%",
            },
            riskRadar,
            riskBuckets,
            npaMonthTrend: ["Sep", "Oct", "Nov", "Dec", "Jan", "Feb"].map((month, i) => ({ month, npa: npaRatio * (0.9 + (i * 0.02)) })),
            highRiskMembers: highRisk,
        });
    }
    catch (err) {
        console.error("[Reports Risk]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/reports/portfolio — Loan portfolio heatmap, aging, summary
router.get("/portfolio", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const today = new Date();
        const loans = await prisma_1.default.loan.findMany({
            where: { tenantId, disbursedAt: { not: null }, status: { in: ["active", "npa"] } },
            include: { member: true },
        });
        const byType = {};
        for (const l of loans) {
            const type = l.loanType;
            if (!byType[type])
                byType[type] = { size: 0, count: 0, npa: 0, npaCount: 0 };
            byType[type].size += Number(l.outstandingPrincipal);
            byType[type].count++;
            if (l.status === "npa")
                byType[type].npaCount++;
        }
        const heatmapData = Object.entries(byType).map(([name, v]) => ({
            name: name.charAt(0).toUpperCase() + name.slice(1),
            size: v.size,
            count: v.count,
            npa: v.count > 0 ? (v.npaCount / v.count) * 100 : 0,
            color: v.count > 0 && v.npaCount / v.count > 0.06 ? "#ef4444" : v.count > 0 && v.npaCount / v.count > 0.03 ? "#f59e0b" : "#22c55e",
        }));
        const agingRanges = [
            { range: "0-3 months", min: 0, max: 90, amount: 0, count: 0 },
            { range: "3-6 months", min: 91, max: 180, amount: 0, count: 0 },
            { range: "6-12 months", min: 181, max: 365, amount: 0, count: 0 },
            { range: "1-2 years", min: 366, max: 730, amount: 0, count: 0 },
            { range: "2-3 years", min: 731, max: 1095, amount: 0, count: 0 },
            { range: "3+ years", min: 1096, max: 99999, amount: 0, count: 0 },
        ];
        for (const l of loans) {
            const disb = l.disbursedAt ? new Date(l.disbursedAt) : today;
            const days = Math.floor((today.getTime() - disb.getTime()) / (24 * 60 * 60 * 1000));
            const amt = Number(l.outstandingPrincipal);
            const r = agingRanges.find((x) => days >= x.min && days <= x.max);
            if (r)
                r.amount += amt, r.count++;
        }
        const totalPortfolio = heatmapData.reduce((s, d) => s + d.size, 0);
        const totalNpa = heatmapData.reduce((s, d) => s + d.size * (d.npa / 100), 0);
        res.json({
            success: true,
            heatmapData,
            agingData: agingRanges.map((r) => ({ range: r.range, amount: r.amount, count: r.count })),
            kpis: {
                totalPortfolio,
                totalNpa,
                activeLoans: loans.length,
                avgLoanSize: loans.length > 0 ? totalPortfolio / loans.length : 0,
            },
            officerPerformance: [],
        });
    }
    catch (err) {
        console.error("[Reports Portfolio]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=reports.js.map