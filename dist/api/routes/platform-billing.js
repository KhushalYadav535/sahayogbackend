"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Platform billing config - super admin sets plan MRR and per-tenant overrides.
 * Tenants see their billing amount from this config.
 */
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const DEFAULT_PLANS = { starter: 1000, pro: 5000, enterprise: 15000 };
async function getPlanMrr() {
    const cfg = await prisma_1.default.platformConfig.findUnique({
        where: { key: "billing_plans" },
    });
    if (!cfg?.value)
        return DEFAULT_PLANS;
    try {
        const parsed = JSON.parse(cfg.value);
        return { ...DEFAULT_PLANS, ...parsed };
    }
    catch {
        return DEFAULT_PLANS;
    }
}
// GET /api/v1/platform/billing/me — tenant's own billing (set by super admin)
router.get("/me", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const tenant = await prisma_1.default.tenant.findUnique({
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
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/billing/plans — super admin + tenants (tenants use for their billing display)
router.get("/plans", auth_1.authMiddleware, async (_req, res) => {
    try {
        const plans = await getPlanMrr();
        res.json({ success: true, plans });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/platform/billing/plans — super admin only
router.put("/plans", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const body = zod_1.z.object({
            starter: zod_1.z.number().min(0).optional(),
            pro: zod_1.z.number().min(0).optional(),
            enterprise: zod_1.z.number().min(0).optional(),
        }).parse(req.body);
        const current = await getPlanMrr();
        const next = { ...current, ...body };
        const value = JSON.stringify(next);
        await prisma_1.default.platformConfig.upsert({
            where: { key: "billing_plans" },
            update: { value, label: "Plan MRR (₹/month)" },
            create: { key: "billing_plans", value, label: "Plan MRR (₹/month)" },
        });
        res.json({ success: true, plans: next });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/billing/overrides — all tenant overrides (super admin)
router.get("/overrides", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (_req, res) => {
    try {
        const overrides = await prisma_1.default.tenantBilling.findMany({
            include: { tenant: { select: { id: true, name: true, code: true, plan: true } } },
        });
        res.json({ success: true, overrides });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/platform/billing/overrides/:tenantId — set per-tenant MRR override (super admin)
router.put("/overrides/:tenantId", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const { mrr } = zod_1.z.object({ mrr: zod_1.z.number().min(0) }).parse(req.body);
        const tenantId = req.params.tenantId;
        await prisma_1.default.tenantBilling.upsert({
            where: { tenantId },
            update: { mrr },
            create: { tenantId, mrr },
        });
        res.json({ success: true, tenantId, mrr });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// DELETE /api/v1/platform/billing/overrides/:tenantId — remove override, use plan default
router.delete("/overrides/:tenantId", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        await prisma_1.default.tenantBilling.deleteMany({ where: { tenantId: req.params.tenantId } });
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=platform-billing.js.map