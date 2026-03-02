/**
 * Platform billing config - super admin sets plan MRR and per-tenant overrides.
 * Tenants see their billing amount from this config.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

const DEFAULT_PLANS = { starter: 1000, pro: 5000, enterprise: 15000 };

async function getPlanMrr(): Promise<Record<string, number>> {
    const cfg = await prisma.platformConfig.findUnique({
        where: { key: "billing_plans" },
    });
    if (!cfg?.value) return DEFAULT_PLANS;
    try {
        const parsed = JSON.parse(cfg.value) as Record<string, number>;
        return { ...DEFAULT_PLANS, ...parsed };
    } catch {
        return DEFAULT_PLANS;
    }
}

// GET /api/v1/platform/billing/me — tenant's own billing (set by super admin)
router.get("/me", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            include: { billingOverride: true },
        });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Tenant not found" });
            return;
        }
        const plans = await getPlanMrr();
        const plan = (tenant.plan || "starter").toLowerCase();
        const planKey = plan === "professional" ? "pro" : plan;
        const override = tenant.billingOverride;
        const mrr = override?.mrr != null ? Number(override.mrr) : (plans[planKey] ?? DEFAULT_PLANS.starter);
        res.json({
            success: true,
            billing: {
                plan: tenant.plan,
                mrr,
                arr: mrr * 12,
                isOverride: !!override,
            },
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/billing/plans — super admin + tenants (tenants use for their billing display)
router.get("/plans", authMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
        const plans = await getPlanMrr();
        res.json({ success: true, plans });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/billing/plans — super admin only
router.put("/plans", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = z.object({
            starter: z.number().min(0).optional(),
            pro: z.number().min(0).optional(),
            enterprise: z.number().min(0).optional(),
        }).parse(req.body);

        const current = await getPlanMrr();
        const next = { ...current, ...body };
        const value = JSON.stringify(next);

        await prisma.platformConfig.upsert({
            where: { key: "billing_plans" },
            update: { value, label: "Plan MRR (₹/month)" },
            create: { key: "billing_plans", value, label: "Plan MRR (₹/month)" },
        });
        res.json({ success: true, plans: next });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/billing/overrides — all tenant overrides (super admin)
router.get("/overrides", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const overrides = await prisma.tenantBilling.findMany({
            include: { tenant: { select: { id: true, name: true, code: true, plan: true } } },
        });
        res.json({ success: true, overrides });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/billing/overrides/:tenantId — set per-tenant MRR override (super admin)
router.put("/overrides/:tenantId", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { mrr } = z.object({ mrr: z.number().min(0) }).parse(req.body);
        const tenantId = req.params.tenantId;

        await prisma.tenantBilling.upsert({
            where: { tenantId },
            update: { mrr },
            create: { tenantId, mrr },
        });
        res.json({ success: true, tenantId, mrr });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// DELETE /api/v1/platform/billing/overrides/:tenantId — remove override, use plan default
router.delete("/overrides/:tenantId", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        await prisma.tenantBilling.deleteMany({ where: { tenantId: req.params.tenantId } });
        res.json({ success: true });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
