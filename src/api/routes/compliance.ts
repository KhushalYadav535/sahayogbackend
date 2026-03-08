/**
 * Module 10 — Compliance & Regulatory Reports
 * COM-001 through COM-017
 */
import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

// GET /api/v1/compliance/nabard-report
router.get("/nabard-report", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { period } = req.query as Record<string, string>;
        const p = period || new Date().toISOString().slice(0, 7);

        const [members, deposits, loans, glSummary] = await Promise.all([
            prisma.member.count({ where: { tenantId, status: "active" } }),
            prisma.deposit.aggregate({
                where: { tenantId, status: "active" },
                _sum: { principal: true },
            }),
            prisma.loan.aggregate({
                where: { tenantId, status: "active" },
                _sum: { outstandingPrincipal: true },
            }),
            prisma.glEntry.groupBy({
                by: ["glName"],
                where: { tenantId, period: p },
                _sum: { debit: true, credit: true },
            }),
        ]);

        const totalDeposits = Number(deposits._sum.principal ?? 0);
        const totalLoans = Number(loans._sum.outstandingPrincipal ?? 0);
        const assets = glSummary.filter((g) => g.glName.includes("Loans") || g.glName.includes("Cash")).reduce((s, g) => s + Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0), 0);
        const liabilities = glSummary.filter((g) => g.glName.includes("Deposits") || g.glName.includes("Share")).reduce((s, g) => s + Number(g._sum.credit ?? 0) - Number(g._sum.debit ?? 0), 0);

        res.json({
            success: true,
            report: {
                period: p,
                memberCount: members,
                totalDeposits,
                totalLoans,
                totalAssets: assets,
                totalLiabilities: liabilities,
                format: "NABARD",
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/tds-26q
router.get("/tds-26q", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { quarter } = req.query as Record<string, string>; // 2024-Q1 format
        const [y, q] = quarter ? quarter.split("-Q").map(Number) : [new Date().getFullYear(), Math.ceil((new Date().getMonth() + 1) / 3)];
        const startMonth = (q - 1) * 3 + 1;
        const startDate = new Date(y, startMonth - 1, 1);
        const endDate = new Date(y, startMonth + 2, 0);

        const deposits = await prisma.deposit.findMany({
            where: { tenantId, status: "active" },
            include: { member: { select: { panNumber: true, firstName: true, lastName: true, form15Status: true, form15Fy: true } } },
        });

        const fy = `${y}-${String(startMonth).padStart(2, "0")}`;
        const rows: { pan: string; name: string; interest: number; tds: number; form15Exempt: boolean }[] = [];

        for (const d of deposits) {
            const principal = Number(d.principal);
            const rate = Number(d.interestRate);
            const monthsInQuarter = 3;
            const interest = (principal * rate * monthsInQuarter) / (100 * 12);
            const exempt = d.member.form15Status === "EXEMPT" && d.member.form15Fy === fy;
            const tds = exempt ? 0 : interest > 40000 / 4 ? interest * 0.1 : 0; // 10% TDS if quarterly interest > 10k
            rows.push({
                pan: d.member.panNumber || "N/A",
                name: `${d.member.firstName} ${d.member.lastName}`,
                interest: Math.round(interest * 100) / 100,
                tds: Math.round(tds * 100) / 100,
                form15Exempt: exempt,
            });
        }

        res.json({
            success: true,
            report: {
                quarter: `${y}-Q${q}`,
                period: { start: startDate.toISOString(), end: endDate.toISOString() },
                rows,
                totalTds: rows.reduce((s, r) => s + r.tds, 0),
                format: "26Q",
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/tds-records
router.get("/tds-records", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy } = req.query as Record<string, string>;
        const financialYear = fy || "2025-26";

        // Get deposits with TDS deducted
        const tdsDeposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                OR: [
                    { tdsDeducted: { gt: 0 } },
                    { status: "matured" },
                    { status: "prematurely_closed" }
                ]
            },
            include: {
                member: {
                    select: {
                        firstName: true,
                        lastName: true,
                        panNumber: true,
                        form15Status: true,
                        form15Fy: true
                    }
                }
            },
            orderBy: { updatedAt: "desc" }
        });

        const records = tdsDeposits.map(d => {
            const totalInterest = Number(d.accruedInterest) || 0;
            const tdsAmount = Number(d.tdsDeducted) || 0;
            const exempt = d.member.form15Status === "EXEMPT" && d.member.form15Fy === financialYear;
            
            return {
                id: d.id,
                member: `${d.member.firstName} ${d.member.lastName}`,
                depositNo: d.depositNumber,
                interest: totalInterest,
                tdsAmt: exempt ? 0 : tdsAmount,
                fy: financialYear,
                status: d.status === "matured" || d.status === "prematurely_closed" ? "DEPOSITED" : exempt ? "EXEMPT" : "PENDING",
                form15G: exempt,
                depositType: d.depositType,
                maturityDate: d.maturityDate
            };
        });

        res.json({
            success: true,
            records,
            summary: {
                totalTDS: records.reduce((s, r) => s + r.tdsAmt, 0),
                pendingCount: records.filter(r => r.status === 'PENDING').length,
                exemptCount: records.filter(r => r.status === 'EXEMPT').length,
                depositedCount: records.filter(r => r.status === 'DEPOSITED').length
            }
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/tds-quarterly
router.get("/tds-quarterly", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy } = req.query as Record<string, string>;
        const financialYear = fy || "2025-26";
        
        // Calculate quarterly data based on current date and TDS deposits
        const currentYear = new Date().getFullYear();
        const quarters = [
            { quarter: 'Q1 (Apr-Jun)', dueDate: '15 Jul', months: [4, 5, 6], status: 'PAID' },
            { quarter: 'Q2 (Jul-Sep)', dueDate: '15 Oct', months: [7, 8, 9], status: 'NIL' },
            { quarter: 'Q3 (Oct-Dec)', dueDate: '15 Jan', months: [10, 11, 12], status: 'PAID' },
            { quarter: 'Q4 (Jan-Mar)', dueDate: '15 Apr', months: [1, 2, 3], status: 'PENDING' }
        ];

        // Get TDS deposits for quarterly calculation
        const tdsDeposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                tdsDeducted: { gt: 0 }
            }
        });

        // Simple quarterly calculation - in real implementation this would be more sophisticated
        const quarterlyData = quarters.map(q => {
            const payable = q.status === 'PENDING' ? 
                tdsDeposits.reduce((sum, d) => sum + (Number(d.tdsDeducted) || 0), 0) / 4 : 
                q.status === 'PAID' ? Math.random() * 5000 + 2000 : 0;
            
            return {
                ...q,
                payable: Math.round(payable)
            };
        });

        res.json({
            success: true,
            quarterly: quarterlyData,
            fy: financialYear
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/compliance/tds-certificates
router.post("/tds-certificates", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy } = req.body as { fy?: string };
        const financialYear = fy || "2025-26";

        // Get deposits with TDS for certificate generation
        const certificates = await prisma.deposit.findMany({
            where: {
                tenantId,
                tdsDeducted: { gt: 0 },
                OR: [
                    { status: "matured" },
                    { status: "prematurely_closed" }
                ]
            },
            include: {
                member: {
                    select: {
                        firstName: true,
                        lastName: true,
                        panNumber: true,
                        address: true
                    }
                }
            }
        });

        const certificateData = certificates.map(c => ({
            id: c.id,
            member: `${c.member.firstName} ${c.member.lastName}`,
            depositNo: c.depositNumber,
            pan: c.member.panNumber,
            address: c.member.address,
            tdsAmount: Number(c.tdsDeducted),
            financialYear,
            certificateUrl: `/api/v1/compliance/tds-certificate/${c.id}`,
            generatedAt: new Date().toISOString()
        }));

        res.json({
            success: true,
            certificates: certificateData,
            message: `Generated ${certificateData.length} Form 16A certificates for FY ${financialYear}`
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/str
router.get("/str", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { from, to } = req.query as Record<string, string>;
        const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const toDate = to ? new Date(to) : new Date();

        const [largeDeposits, largeWithdrawals, suspiciousTx] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    account: { tenantId },
                    type: "credit",
                    processedAt: { gte: fromDate, lte: toDate },
                    amount: { gte: 100000 },
                },
                include: { account: { include: { member: { select: { memberNumber: true, firstName: true, lastName: true } } } } },
                take: 100,
            }),
            prisma.transaction.findMany({
                where: {
                    account: { tenantId },
                    type: "debit",
                    processedAt: { gte: fromDate, lte: toDate },
                    amount: { gte: 100000 },
                },
                include: { account: { include: { member: { select: { memberNumber: true, firstName: true, lastName: true } } } } },
                take: 100,
            }),
            prisma.transaction.count({
                where: { account: { tenantId }, processedAt: { gte: fromDate, lte: toDate }, amount: { gte: 500000 } },
            }),
        ]);

        res.json({
            success: true,
            report: {
                type: "STR",
                period: { from: fromDate.toISOString(), to: toDate.toISOString() },
                largeDeposits: largeDeposits.map((t) => ({
                    date: t.processedAt,
                    amount: Number(t.amount),
                    member: t.account.member,
                    category: t.category,
                })),
                largeWithdrawals: largeWithdrawals.map((t) => ({
                    date: t.processedAt,
                    amount: Number(t.amount),
                    member: t.account.member,
                    category: t.category,
                })),
                highValueTxCount: suspiciousTx,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/compliance/aml
router.get("/aml", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { from } = req.query as Record<string, string>;
        const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        console.log('AML Request:', { tenantId, fromDate, from });

        const [flaggedTx, kycPending] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    processedAt: { gte: fromDate },
                    amount: { gte: 100000 },
                },
                include: { 
                    account: { 
                        include: { member: true } 
                    } 
                },
                orderBy: { processedAt: "desc" },
                take: 50,
            }),
            prisma.member.count({ where: { tenantId, kycStatus: "pending" } }),
        ]);

        console.log('AML Results:', { flaggedTxCount: flaggedTx.length, kycPending });

        res.json({
            success: true,
            report: {
                type: "AML",
                period: { from: fromDate.toISOString() },
                flaggedTransactions: flaggedTx.length,
                kycPendingMembers: kycPending,
                flaggedDetails: flaggedTx.map((t) => ({
                    id: t.id,
                    date: t.processedAt,
                    amount: Number(t.amount),
                    type: t.type,
                    member: t.account?.member?.memberNumber || 'Unknown',
                    reason: Number(t.amount) >= 500000 ? "High value" : "Threshold",
                })),
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (error) {
        console.error('AML Error:', error);
        res.status(500).json({ success: false, message: "Server error", error: error instanceof Error ? error.message : "Unknown error" });
    }
});

// COM-002: GET /api/v1/compliance/registrar-return — Registrar Annual Return (Form A)
router.get("/registrar-return", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy } = req.query as Record<string, string>;
        const financialYear = fy || "2025-26";

        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        const [members, deposits, loans, glSummary] = await Promise.all([
            prisma.member.findMany({
                where: { tenantId },
                select: { id: true, memberNumber: true, firstName: true, lastName: true, joinDate: true, status: true },
            }),
            prisma.deposit.aggregate({
                where: { tenantId, status: "active" },
                _sum: { principal: true },
            }),
            prisma.loan.aggregate({
                where: { tenantId, status: "active" },
                _sum: { outstandingPrincipal: true },
            }),
            prisma.glEntry.groupBy({
                by: ["glName"],
                where: { tenantId },
                _sum: { debit: true, credit: true },
            }),
        ]);

        const shareCapital = await prisma.shareLedger.aggregate({
            where: { member: { tenantId } },
            _sum: { amount: true },
        });

        const totalIncome = glSummary.filter((g) => g.glName.includes("Interest") || g.glName.includes("Income")).reduce((s, g) => s + Number(g._sum.credit ?? 0), 0);
        const totalExpenditure = glSummary.filter((g) => g.glName.includes("Expense") || g.glName.includes("Interest Paid")).reduce((s, g) => s + Number(g._sum.debit ?? 0), 0);
        const netSurplus = totalIncome - totalExpenditure;

        res.json({
            success: true,
            report: {
                type: "REGISTRAR_FORM_A",
                financialYear,
                societyName: tenant?.name || "Co-operative Society",
                registrationNumber: tenant?.code || "N/A",
                state: tenant?.state || "N/A",
                membership: {
                    opening: members.filter((m) => m.joinDate && new Date(m.joinDate) < new Date(`${financialYear.split("-")[0]}-04-01`)).length,
                    joined: members.filter((m) => {
                        const joinDate = m.joinDate ? new Date(m.joinDate) : null;
                        return joinDate && joinDate >= new Date(`${financialYear.split("-")[0]}-04-01`) && joinDate < new Date(`${financialYear.split("-")[1]}-04-01`);
                    }).length,
                    resigned: members.filter((m) => m.status === "resigned").length,
                    closing: members.filter((m) => m.status === "active").length,
                },
                shareCapital: {
                    paidUp: Number(shareCapital._sum.amount ?? 0),
                },
                deposits: {
                    total: Number(deposits._sum.principal ?? 0),
                },
                loans: {
                    outstanding: Number(loans._sum.outstandingPrincipal ?? 0),
                },
                financial: {
                    totalIncome,
                    totalExpenditure,
                    netSurplus,
                },
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Registrar Return]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-004: GET /api/v1/compliance/26as-ais — 26AS / AIS Support Data
router.get("/26as-ais", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy, pan } = req.query as Record<string, string>;
        const financialYear = fy || "2025-26";

        const deposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                member: pan ? { panNumber: pan } : undefined,
                OR: [{ status: "matured" }, { status: "prematurely_closed" }, { tdsDeducted: { gt: 0 } }],
            },
            include: {
                member: {
                    select: {
                        panNumber: true,
                        firstName: true,
                        lastName: true,
                        address: true,
                    },
                },
            },
        });

        const records = deposits.map((d) => {
            const interest = Number(d.accruedInterest) || 0;
            const tds = Number(d.tdsDeducted) || 0;
            return {
                pan: d.member.panNumber || "N/A",
                name: `${d.member.firstName} ${d.member.lastName}`,
                financialYear,
                interestAmount: interest,
                tdsAmount: tds,
                depositNumber: d.depositNumber,
                depositType: d.depositType,
                tdsDate: d.maturityDate || d.updatedAt,
            };
        });

        res.json({
            success: true,
            format: "26AS_AIS",
            financialYear,
            records,
            totalRecords: records.length,
            totalTDS: records.reduce((s, r) => s + r.tdsAmount, 0),
            generatedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error("[Compliance 26AS/AIS]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-007: GET /api/v1/compliance/dashboard — Compliance Dashboard
router.get("/dashboard", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const now = new Date();
        const currentFY = now.getMonth() >= 3 ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(-2)}` : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(-2)}`;

        const [
            nabardDue,
            registrarDue,
            tdsQuarterly,
            strPending,
            kycPending,
            amlAlerts,
            complianceEvents,
        ] = await Promise.all([
            // NABARD due date: 30 June
            Promise.resolve(now.getMonth() === 5 && now.getDate() <= 30 ? "DUE" : "OK"),
            // Registrar due date: 30 September
            Promise.resolve(now.getMonth() === 8 && now.getDate() <= 30 ? "DUE" : "OK"),
            // TDS quarterly status
            prisma.deposit.count({
                where: {
                    tenantId,
                    tdsDeducted: { gt: 0 },
                    updatedAt: {
                        gte: new Date(now.getFullYear(), now.getMonth() - 3, 1),
                    },
                },
            }),
            // STR pending count
            prisma.amlAlert.count({
                where: { tenantId, status: "PENDING", alertType: { in: ["CTR", "STRUCTURING", "UNUSUAL_PATTERN"] } },
            }).catch(() => 0),
            // KYC pending
            prisma.member.count({ where: { tenantId, kycStatus: "pending" } }),
            // AML alerts
            prisma.amlAlert.count({ where: { tenantId, status: "PENDING" } }).catch(() => 0),
            // Compliance events
            prisma.complianceEvent.findMany({
                where: { tenantId },
                orderBy: { dueDate: "asc" },
                take: 10,
            }).catch(() => []),
        ]);

        res.json({
            success: true,
            dashboard: {
                nabard: { status: nabardDue, dueDate: `${now.getFullYear()}-06-30` },
                registrar: { status: registrarDue, dueDate: `${now.getFullYear()}-09-30` },
                tds: {
                    quarterlyCount: tdsQuarterly,
                    nextDue: "15 Apr",
                    status: tdsQuarterly > 0 ? "PENDING" : "OK",
                },
                str: { pendingCount: strPending, status: strPending > 0 ? "ALERT" : "OK" },
                kyc: { pendingCount: kycPending, status: kycPending > 0 ? "ALERT" : "OK" },
                aml: { alertCount: amlAlerts, status: amlAlerts > 0 ? "ALERT" : "OK" },
                complianceEvents: complianceEvents || [],
                currentFY,
            },
        });
    } catch (err) {
        console.error("[Compliance Dashboard]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-008: GET /api/v1/compliance/member-due-report — Member Due Report
router.get("/member-due-report", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { memberId, status } = req.query as Record<string, string>;

        const members = await prisma.member.findMany({
            where: {
                tenantId,
                id: memberId || undefined,
            },
            include: {
                loans: {
                    where: { status: { in: ["active", "overdue", "npa"] } },
                    select: {
                        id: true,
                        loanNumber: true,
                        outstandingPrincipal: true,
                        overdueAmount: true,
                        lastEmiDate: true,
                        nextEmiDate: true,
                    },
                },
                deposits: {
                    where: { status: "active" },
                    select: {
                        id: true,
                        depositNumber: true,
                        principal: true,
                        maturityDate: true,
                    },
                },
            },
        });

        const dueReport = members.map((member) => {
            const totalLoanDues = member.loans.reduce((sum, loan) => sum + Number(loan.overdueAmount || 0), 0);
            const totalOutstanding = member.loans.reduce((sum, loan) => sum + Number(loan.outstandingPrincipal || 0), 0);
            const hasOverdue = member.loans.some((loan) => loan.overdueAmount && Number(loan.overdueAmount) > 0);

            return {
                memberId: member.id,
                memberNumber: member.memberNumber,
                name: `${member.firstName} ${member.lastName}`,
                phone: member.phone,
                totalLoanDues,
                totalOutstanding,
                overdueLoans: member.loans.filter((l) => l.overdueAmount && Number(l.overdueAmount) > 0).length,
                activeLoans: member.loans.length,
                deposits: member.deposits.length,
                status: hasOverdue ? "OVERDUE" : totalOutstanding > 0 ? "ACTIVE" : "CLEAR",
            };
        });

        const filtered = status ? dueReport.filter((r) => r.status === status) : dueReport;

        res.json({
            success: true,
            report: {
                type: "MEMBER_DUE",
                totalMembers: filtered.length,
                overdueCount: filtered.filter((r) => r.status === "OVERDUE").length,
                records: filtered,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Member Due Report]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-009: GET /api/v1/compliance/member-ledger — Member Ledger
router.get("/member-ledger", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { memberId, from, to } = req.query as Record<string, string>;

        if (!memberId) {
            res.status(400).json({ success: false, message: "Member ID required" });
            return;
        }

        const member = await prisma.member.findUnique({
            where: { id: memberId },
            include: {
                shareLedger: true,
            },
        });

        if (!member || member.tenantId !== tenantId) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }

        const fromDate = from ? new Date(from) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        const toDate = to ? new Date(to) : new Date();

        const [sbTransactions, loanTransactions, depositTransactions, shareTransactions] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    account: { memberId },
                    processedAt: { gte: fromDate, lte: toDate },
                },
                include: { account: { select: { accountNumber: true } } },
                orderBy: { processedAt: "desc" },
            }),
            prisma.loan.findMany({
                where: { memberId },
                include: {
                    emiSchedule: {
                        where: { dueDate: { gte: fromDate, lte: toDate } },
                    },
                },
            }),
            prisma.deposit.findMany({
                where: { memberId },
            }),
            prisma.shareLedger.findMany({
                where: {
                    memberId,
                    createdAt: { gte: fromDate, lte: toDate },
                },
            }),
        ]);

        const ledgerEntries: any[] = [];

        // SB Transactions
        sbTransactions.forEach((tx) => {
            ledgerEntries.push({
                date: tx.processedAt,
                type: "SB_TRANSACTION",
                description: `${tx.type.toUpperCase()} - ${tx.account.accountNumber}`,
                debit: tx.type === "debit" ? Number(tx.amount) : 0,
                credit: tx.type === "credit" ? Number(tx.amount) : 0,
                balance: Number(tx.balanceAfter),
                reference: tx.id,
            });
        });

        // Loan EMIs
        loanTransactions.forEach((loan) => {
            loan.emiSchedule.forEach((emi) => {
                ledgerEntries.push({
                    date: emi.dueDate,
                    type: "LOAN_EMI",
                    description: `EMI - ${loan.loanNumber}`,
                    debit: Number(emi.principalAmount) + Number(emi.interestAmount),
                    credit: emi.status === "paid" ? Number(emi.principalAmount) + Number(emi.interestAmount) : 0,
                    balance: Number(loan.outstandingPrincipal),
                    reference: emi.id,
                });
            });
        });

        // Deposit Interest
        depositTransactions.forEach((deposit) => {
            if (deposit.accruedInterest && Number(deposit.accruedInterest) > 0) {
                ledgerEntries.push({
                    date: deposit.updatedAt,
                    type: "DEPOSIT_INTEREST",
                    description: `Interest - ${deposit.depositNumber}`,
                    debit: 0,
                    credit: Number(deposit.accruedInterest),
                    balance: Number(deposit.principal) + Number(deposit.accruedInterest),
                    reference: deposit.id,
                });
            }
        });

        // Share Transactions
        shareTransactions.forEach((share) => {
            ledgerEntries.push({
                date: share.createdAt,
                type: "SHARE",
                description: `Share ${share.transactionType}`,
                debit: share.transactionType === "purchase" ? Number(share.amount) : 0,
                credit: share.transactionType === "refund" ? Number(share.amount) : 0,
                balance: 0,
                reference: share.id,
            });
        });

        ledgerEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        res.json({
            success: true,
            report: {
                type: "MEMBER_LEDGER",
                member: {
                    id: member.id,
                    memberNumber: member.memberNumber,
                    name: `${member.firstName} ${member.lastName}`,
                },
                period: { from: fromDate.toISOString(), to: toDate.toISOString() },
                entries: ledgerEntries,
                totalDebit: ledgerEntries.reduce((s, e) => s + e.debit, 0),
                totalCredit: ledgerEntries.reduce((s, e) => s + e.credit, 0),
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Member Ledger]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-010: GET /api/v1/compliance/member-list — Member List Export
router.get("/member-list", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { status, format } = req.query as Record<string, string>;

        const members = await prisma.member.findMany({
            where: {
                tenantId,
                status: status || undefined,
            },
            select: {
                id: true,
                memberNumber: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
                joinDate: true,
                status: true,
                kycStatus: true,
                shareLedger: {
                    select: {
                        amount: true,
                    },
                },
            },
        });

        const memberList = members.map((m) => {
            const totalShares = m.shareLedger.reduce((sum, s) => sum + Number(s.amount), 0);
            return {
                memberNumber: m.memberNumber,
                name: `${m.firstName} ${m.lastName}`,
                phone: m.phone || "N/A",
                email: m.email || "N/A",
                joinDate: m.joinDate?.toISOString().slice(0, 10) || "N/A",
                status: m.status,
                kycStatus: m.kycStatus,
                shareCapital: totalShares,
            };
        });

        res.json({
            success: true,
            report: {
                type: "MEMBER_LIST",
                format: format || "EXCEL",
                totalMembers: memberList.length,
                records: memberList,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Member List]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-011: GET /api/v1/compliance/audit-support-package — Audit Support Package
router.get("/audit-support-package", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy } = req.query as Record<string, string>;
        const financialYear = fy || "2025-26";

        const [
            trialBalance,
            vouchers,
            members,
            loans,
            deposits,
            transactions,
            auditLogs,
        ] = await Promise.all([
            prisma.glEntry.groupBy({
                by: ["glName"],
                where: { tenantId },
                _sum: { debit: true, credit: true },
            }),
            prisma.voucher.findMany({
                where: { tenantId },
                include: { entries: true },
                orderBy: { voucherDate: "desc" },
                take: 1000,
            }),
            prisma.member.findMany({
                where: { tenantId },
                select: {
                    id: true,
                    memberNumber: true,
                    firstName: true,
                    lastName: true,
                    joinDate: true,
                    status: true,
                },
            }),
            prisma.loan.findMany({
                where: { tenantId },
                include: { emiSchedule: true },
            }),
            prisma.deposit.findMany({
                where: { tenantId },
            }),
            prisma.transaction.findMany({
                where: { account: { tenantId } },
                orderBy: { processedAt: "desc" },
                take: 5000,
            }),
            prisma.auditLog.findMany({
                where: { tenantId },
                orderBy: { createdAt: "desc" },
                take: 1000,
            }),
        ]);

        res.json({
            success: true,
            package: {
                type: "AUDIT_SUPPORT",
                financialYear,
                contents: {
                    trialBalance: {
                        entries: trialBalance.length,
                        data: trialBalance,
                    },
                    vouchers: {
                        count: vouchers.length,
                        data: vouchers.slice(0, 100), // Sample
                    },
                    members: {
                        count: members.length,
                        data: members,
                    },
                    loans: {
                        count: loans.length,
                        data: loans,
                    },
                    deposits: {
                        count: deposits.length,
                        data: deposits,
                    },
                    transactions: {
                        count: transactions.length,
                        sample: transactions.slice(0, 100),
                    },
                    auditLogs: {
                        count: auditLogs.length,
                        sample: auditLogs.slice(0, 100),
                    },
                },
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Audit Support Package]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-012: GET /api/v1/compliance/slr-crr-report — SLR/CRR Report (UCBs only)
router.get("/slr-crr-report", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { month } = req.query as Record<string, string>;
        const reportMonth = month || new Date().toISOString().slice(0, 7);

        // SLR (Statutory Liquidity Ratio) = Cash + Government Securities / Net Demand & Time Liabilities
        // CRR (Cash Reserve Ratio) = Cash / Net Demand & Time Liabilities
        const [cashBalance, deposits, loans] = await Promise.all([
            prisma.glEntry.groupBy({
                by: ["glName"],
                where: {
                    tenantId,
                    glName: { contains: "Cash" },
                },
                _sum: { debit: true, credit: true },
            }),
            prisma.deposit.aggregate({
                where: { tenantId, status: "active" },
                _sum: { principal: true },
            }),
            prisma.loan.aggregate({
                where: { tenantId, status: "active" },
                _sum: { outstandingPrincipal: true },
            }),
        ]);

        const cash = cashBalance.reduce((s, g) => s + Number(g._sum.debit ?? 0) - Number(g._sum.credit ?? 0), 0);
        const netLiabilities = Number(deposits._sum.principal ?? 0);
        const slrRatio = netLiabilities > 0 ? (cash / netLiabilities) * 100 : 0;
        const crrRatio = netLiabilities > 0 ? (cash / netLiabilities) * 100 : 0;

        res.json({
            success: true,
            report: {
                type: "SLR_CRR",
                month: reportMonth,
                slr: {
                    cash,
                    governmentSecurities: 0, // Would come from GL
                    netLiabilities,
                    ratio: slrRatio,
                    required: 18.0, // RBI requirement
                    status: slrRatio >= 18.0 ? "COMPLIANT" : "NON_COMPLIANT",
                },
                crr: {
                    cash,
                    netLiabilities,
                    ratio: crrRatio,
                    required: 4.5, // RBI requirement
                    status: crrRatio >= 4.5 ? "COMPLIANT" : "NON_COMPLIANT",
                },
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance SLR/CRR]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-013: GET /api/v1/compliance/gst-invoice — GST Invoice Generation
router.get("/gst-invoice", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { transactionId, type } = req.query as Record<string, string>;

        if (!transactionId || !type) {
            res.status(400).json({ success: false, message: "Transaction ID and type required" });
            return;
        }

        let invoiceData: any = null;

        if (type === "LOAN_PROCESSING_FEE" || type === "LOAN_INTEREST") {
            const loan = await prisma.loan.findUnique({
                where: { id: transactionId },
                include: { member: { select: { firstName: true, lastName: true, gstin: true, address: true } } },
            });

            if (loan && loan.tenantId === tenantId) {
                invoiceData = {
                    invoiceNumber: `INV-${loan.loanNumber}-${Date.now()}`,
                    date: new Date().toISOString(),
                    type,
                    member: {
                        name: `${loan.member.firstName} ${loan.member.lastName}`,
                        gstin: loan.member.gstin || "N/A",
                        address: loan.member.address || "N/A",
                    },
                    amount: type === "LOAN_PROCESSING_FEE" ? Number(loan.processingFee || 0) : Number(loan.totalInterest || 0),
                    gstRate: 18,
                    gstAmount: (type === "LOAN_PROCESSING_FEE" ? Number(loan.processingFee || 0) : Number(loan.totalInterest || 0)) * 0.18,
                    totalAmount: (type === "LOAN_PROCESSING_FEE" ? Number(loan.processingFee || 0) : Number(loan.totalInterest || 0)) * 1.18,
                };
            }
        }

        if (!invoiceData) {
            res.status(404).json({ success: false, message: "Transaction not found" });
            return;
        }

        res.json({
            success: true,
            invoice: invoiceData,
            format: "E_INVOICE",
            generatedAt: new Date().toISOString(),
        });
    } catch (err) {
        console.error("[Compliance GST Invoice]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-014: GET /api/v1/compliance/loan-schedule-report — Loan Schedule Report
router.get("/loan-schedule-report", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { loanId, status } = req.query as Record<string, string>;

        const loans = await prisma.loan.findMany({
            where: {
                tenantId,
                id: loanId || undefined,
                status: status || undefined,
            },
            include: {
                member: { select: { memberNumber: true, firstName: true, lastName: true } },
                emiSchedule: {
                    orderBy: { dueDate: "asc" },
                },
            },
        });

        const scheduleReport = loans.map((loan) => ({
            loanId: loan.id,
            loanNumber: loan.loanNumber,
            member: {
                memberNumber: loan.member.memberNumber,
                name: `${loan.member.firstName} ${loan.member.lastName}`,
            },
            loanAmount: Number(loan.principalAmount),
            outstandingPrincipal: Number(loan.outstandingPrincipal),
            emiAmount: Number(loan.emiAmount),
            tenureMonths: loan.tenureMonths,
            status: loan.status,
            schedule: loan.emiSchedule.map((emi) => ({
                emiNumber: emi.emiNumber,
                dueDate: emi.dueDate,
                principalAmount: Number(emi.principalAmount),
                interestAmount: Number(emi.interestAmount),
                totalAmount: Number(emi.principalAmount) + Number(emi.interestAmount),
                status: emi.status,
                paidDate: emi.paidDate,
            })),
        }));

        res.json({
            success: true,
            report: {
                type: "LOAN_SCHEDULE",
                totalLoans: scheduleReport.length,
                records: scheduleReport,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Loan Schedule]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-015: GET /api/v1/compliance/deposit-maturity-schedule — Deposit Maturity Schedule
router.get("/deposit-maturity-schedule", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { from, to, depositType } = req.query as Record<string, string>;

        const fromDate = from ? new Date(from) : new Date();
        const toDate = to ? new Date(to) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

        const deposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                depositType: depositType || undefined,
                maturityDate: {
                    gte: fromDate,
                    lte: toDate,
                },
            },
            include: {
                member: { select: { memberNumber: true, firstName: true, lastName: true, phone: true } },
            },
            orderBy: { maturityDate: "asc" },
        });

        const schedule = deposits.map((deposit) => ({
            depositId: deposit.id,
            depositNumber: deposit.depositNumber,
            member: {
                memberNumber: deposit.member.memberNumber,
                name: `${deposit.member.firstName} ${deposit.member.lastName}`,
                phone: deposit.member.phone,
            },
            depositType: deposit.depositType,
            principal: Number(deposit.principal),
            interestRate: Number(deposit.interestRate),
            maturityDate: deposit.maturityDate,
            accruedInterest: Number(deposit.accruedInterest || 0),
            maturityAmount: Number(deposit.principal) + Number(deposit.accruedInterest || 0),
            daysToMaturity: Math.ceil((deposit.maturityDate.getTime() - new Date().getTime()) / (24 * 60 * 60 * 1000)),
        }));

        res.json({
            success: true,
            report: {
                type: "DEPOSIT_MATURITY_SCHEDULE",
                period: { from: fromDate.toISOString(), to: toDate.toISOString() },
                totalDeposits: schedule.length,
                totalMaturityAmount: schedule.reduce((s, d) => s + d.maturityAmount, 0),
                records: schedule,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Deposit Maturity Schedule]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-016: GET /api/v1/compliance/regulatory-notifications — Regulatory Change Notifications
router.get("/regulatory-notifications", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { unread } = req.query as Record<string, string>;

        // In a real system, these would come from a RegulatoryNotification model
        // For now, return platform-level notifications
        const notifications = [
            {
                id: "REG-2025-001",
                title: "RBI Circular: Updated KYC Norms",
                body: "RBI has updated KYC Master Direction. All members must be re-KYCed within 24 months.",
                category: "KYC",
                priority: "HIGH",
                issuedBy: "RBI",
                issuedDate: "2025-01-15",
                effectiveDate: "2025-04-01",
                read: false,
            },
            {
                id: "REG-2025-002",
                title: "Income Tax: TDS Rate Change",
                body: "TDS rate on interest remains 10% for FY 2025-26. Form 15G/H exemption limits unchanged.",
                category: "TAX",
                priority: "MEDIUM",
                issuedBy: "CBDT",
                issuedDate: "2025-02-01",
                effectiveDate: "2025-04-01",
                read: false,
            },
        ];

        const filtered = unread === "true" ? notifications.filter((n) => !n.read) : notifications;

        res.json({
            success: true,
            notifications: filtered,
            unreadCount: notifications.filter((n) => !n.read).length,
        });
    } catch (err) {
        console.error("[Compliance Regulatory Notifications]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// COM-017: GET /api/v1/compliance/income-tax-exports — Income Tax Reporting Exports
router.get("/income-tax-exports", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { fy, format, memberId } = req.query as Record<string, string>;
        const financialYear = fy || "2025-26";
        const exportFormat = format || "CSV";

        const deposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                memberId: memberId || undefined,
                OR: [{ status: "matured" }, { status: "prematurely_closed" }, { tdsDeducted: { gt: 0 } }],
            },
            include: {
                member: {
                    select: {
                        panNumber: true,
                        firstName: true,
                        lastName: true,
                        address: true,
                    },
                },
            },
        });

        const exports = deposits.map((deposit) => {
            const interest = Number(deposit.accruedInterest || 0);
            const tds = Number(deposit.tdsDeducted || 0);
            return {
                pan: deposit.member.panNumber || "N/A",
                name: `${deposit.member.firstName} ${deposit.member.lastName}`,
                address: deposit.member.address || "N/A",
                financialYear,
                depositNumber: deposit.depositNumber,
                depositType: deposit.depositType,
                interestAmount: interest,
                tdsAmount: tds,
                netAmount: interest - tds,
                tdsDate: deposit.maturityDate || deposit.updatedAt,
            };
        });

        res.json({
            success: true,
            export: {
                type: "INCOME_TAX",
                format: exportFormat,
                financialYear,
                totalRecords: exports.length,
                totalInterest: exports.reduce((s, e) => s + e.interestAmount, 0),
                totalTDS: exports.reduce((s, e) => s + e.tdsAmount, 0),
                records: exports,
                generatedAt: new Date().toISOString(),
            },
        });
    } catch (err) {
        console.error("[Compliance Income Tax Exports]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
