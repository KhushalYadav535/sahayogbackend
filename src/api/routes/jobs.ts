import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth";
import { postGl, currentPeriod } from "../../lib/gl-posting";
import { STATUTORY_RESERVE_RATE, NCCT_FUND_RATE, DORMANCY_MONTHS, DEAF_ALERT_YEARS } from "../../lib/coa-rules";
import { processNpa } from "../../workers/npa";
import { processDayEnd } from "../../workers/day-end";

const router = Router();

// ─── POST /api/v1/jobs/day-end ────────────────────────────────────────────────
router.post("/day-end", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }

        // Re-use the BullMQ worker logic directly
        const result = await processDayEnd({ data: { tenantId } } as any);

        res.json({
            success: true,
            message: "Day-end processing complete",
            ...result,
        });
    } catch (err) {
        console.error("[day-end]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/jobs/npa-check — Full IRAC classification ──────────────────
router.post("/npa-check", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;

        // Run full IRAC classification via the worker function
        const result = await processNpa({ data: { tenantId } } as any);

        res.json({
            success: true,
            message: "IRAC NPA classification complete",
            ...result,
        });
    } catch (err) {
        console.error("[npa-check]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/jobs/month-end ──────────────────────────────────────────────
router.post("/month-end", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }

        // Run IRAC classification on month-end
        const npaResult = await processNpa({ data: { tenantId } } as any);

        res.json({
            success: true,
            message: "Month-end processing complete",
            npa: npaResult,
        });
    } catch (err) {
        console.error("[month-end]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/jobs/fy-close — FY-close: statutory reserve + NCCT ────────
router.post("/fy-close", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }
        const period = currentPeriod();

        const { netSurplus } = z.object({
            netSurplus: z.number().positive("Net surplus must be positive for FY close"),
        }).parse(req.body);

        // COA: Statutory Reserve — 25% of net surplus (MSCS Act Sec 61)
        const statutoryReserve = Math.round(netSurplus * STATUTORY_RESERVE_RATE * 100) / 100;
        await postGl(tenantId, "STATUTORY_RESERVE", statutoryReserve,
            `FY-close statutory reserve (25% of ₹${netSurplus})`, period);

        // COA: NCCT Fund — 1% of net profit (MSCS Act Sec 62)
        const ncctFund = Math.round(netSurplus * NCCT_FUND_RATE * 100) / 100;
        await postGl(tenantId, "NCCT_FUND", ncctFund,
            `FY-close NCCT Fund (1% of ₹${netSurplus})`, period);

        res.json({
            success: true,
            message: "FY-close processing complete",
            netSurplus,
            statutoryReserve,
            ncctFund,
            period,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, issues: err.issues });
            return;
        }
        console.error("[fy-close]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/jobs/usage-snapshot ────────────────────────────────────────
router.post("/usage-snapshot", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = (req.body || {}) as { period?: string };
        const period =
            body.period || new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().slice(0, 7);

        const tenants = await prisma.tenant.findMany({
            where: { status: { notIn: ["offboarded"] } },
            select: { id: true },
        });

        let created = 0;
        for (const t of tenants) {
            const [memberCount, txnCount, userCount] = await Promise.all([
                prisma.member.count({ where: { tenantId: t.id, status: "active" } }),
                prisma.transaction.count({ where: { account: { tenantId: t.id } } }),
                prisma.user.count({ where: { tenantId: t.id } }),
            ]);

            await prisma.tenantUsageSnapshot.upsert({
                where: { tenantId_period: { tenantId: t.id, period } },
                update: {
                    activeUsersPeak: userCount,
                    memberCount,
                    txnVolume: txnCount,
                },
                create: {
                    tenantId: t.id,
                    period,
                    activeUsersPeak: userCount,
                    memberCount,
                    txnVolume: txnCount,
                },
            });
            created++;
        }

        res.json({ success: true, message: `Usage snapshot created for ${created} tenants`, period });
    } catch (err) {
        console.error("[Usage Snapshot]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/jobs/deaf-alerts — Deposits approaching DEAF Transfer ────────
router.get("/deaf-alerts", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }

        const alertThreshold = new Date();
        alertThreshold.setFullYear(alertThreshold.getFullYear() - Math.floor(DEAF_ALERT_YEARS));

        const deafDeposits = await prisma.deposit.findMany({
            where: {
                tenantId,
                status: "active",
                maturityDate: { lt: alertThreshold },
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } } },
        });

        res.json({ success: true, count: deafDeposits.length, deposits: deafDeposits });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/jobs/overdue-suspense — Suspense entries overdue ─────────────
router.get("/overdue-suspense", authMiddleware, requireRole("superadmin", "admin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant required" });
            return;
        }

        const suspenseMaxDays = 30;
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - suspenseMaxDays);

        const entries = await prisma.suspenseEntry.findMany({
            where: {
                tenantId,
                status: { in: ["OPEN", "OVERDUE"] },
                createdAt: { lt: threshold },
            },
            orderBy: { createdAt: "asc" },
        });

        res.json({ success: true, count: entries.length, entries });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
