/**
 * Platform usage dashboard - cross-tenant aggregates (no raw member/financial data).
 * BRD 286: Usage monitoring dashboard for platform admin.
 */
import { Router, Request, Response } from "express";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole } from "../middleware/auth";

const router = Router();

// GET /api/v1/platform/usage/summary
router.get("/summary", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const period = new Date().toISOString().slice(0, 7);
        const allTenants = await prisma.tenant.findMany({ select: { id: true, name: true, code: true, plan: true, status: true } });
        const tenants = allTenants.filter((t) => (t.status || "active") !== "offboarded").map(({ id, name, code, plan }) => ({ id, name, code, plan }));
        const tenantIds = tenants.map((t) => t.id);

        if (tenantIds.length === 0) {
            return res.json({ success: true, period, summary: [], totals: { totalTenants: 0, totalMembers: 0, totalTxns: 0 } });
        }

        const memberByTenant: Record<string, number> = {};
        for (const tid of tenantIds) {
            try {
                memberByTenant[tid] = await prisma.member.count({ where: { tenantId: tid, status: "active" } });
            } catch {
                memberByTenant[tid] = 0;
            }
        }

        const txnByTenant: Record<string, number> = {};
        for (const tid of tenantIds) {
            try {
                txnByTenant[tid] = await prisma.transaction.count({ where: { account: { tenantId: tid } } });
            } catch {
                txnByTenant[tid] = 0;
            }
        }

        let snapshotByTenant: Record<string, { txnVolume: number; activeUsersPeak: number; aiInvocations: number; apiCalls: number; storageMb: number }> = {};
        try {
            const snapshots = await prisma.tenantUsageSnapshot.findMany({ where: { tenantId: { in: tenantIds }, period } });
            snapshotByTenant = Object.fromEntries(snapshots.map((s) => [s.tenantId, s]));
        } catch {
            /* tenant_usage_snapshots table may not exist - use live counts instead */
        }

        const tenantUsage = tenants.map((t) => {
            const snap = snapshotByTenant[t.id];
            const members = memberByTenant[t.id] ?? 0;
            const txns = txnByTenant[t.id] ?? 0;
            return {
                tenantId: t.id,
                tenantName: t.name,
                tenantCode: t.code,
                plan: t.plan,
                memberCount: members,
                txnVolume: snap?.txnVolume ?? txns,
                activeUsersPeak: snap?.activeUsersPeak ?? 0,
                aiInvocations: snap?.aiInvocations ?? 0,
                apiCalls: snap?.apiCalls ?? 0,
                storageMb: snap?.storageMb ?? 0,
            };
        });

        const totals = {
            totalTenants: tenants.length,
            totalMembers: Object.values(memberByTenant).reduce((a, b) => a + b, 0),
            totalTxns: Object.values(txnByTenant).reduce((a, b) => a + b, 0),
        };

        res.json({ success: true, period, summary: tenantUsage, totals });
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Server error";
        const stack = err instanceof Error ? err.stack : undefined;
        console.error("[Platform Usage]", err);
        res.status(500).json({
            success: false,
            message: process.env.NODE_ENV === "development" ? msg : "Server error",
            ...(process.env.NODE_ENV === "development" && stack && { stack: stack.split("\n").slice(0, 5) }),
        });
    }
});

export default router;
