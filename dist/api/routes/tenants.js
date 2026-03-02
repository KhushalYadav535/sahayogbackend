"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const router = (0, express_1.Router)();
const DEFAULT_PLANS = { starter: 1000, pro: 5000, enterprise: 15000 };
async function getPlanMrr() {
    const cfg = await prisma_1.default.platformConfig.findUnique({ where: { key: "billing_plans" } });
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
const tenantSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    code: zod_1.z.string().min(2).max(20),
    district: zod_1.z.string().optional(),
    state: zod_1.z.string().optional(),
    regNumber: zod_1.z.string().optional(),
    plan: zod_1.z.enum(["starter", "pro", "enterprise"]).default("starter"),
});
const adminUserSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(8),
});
// GET /api/v1/platform/tenants — includes credits and mrr (real data)
router.get("/", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (_req, res) => {
    try {
        const [tenants, plans] = await Promise.all([
            prisma_1.default.tenant.findMany({
                orderBy: { createdAt: "desc" },
                include: {
                    _count: { select: { members: true } },
                    credits: true,
                    billingOverride: true,
                },
            }),
            getPlanMrr(),
        ]);
        const tenantsWithMeta = tenants.map((t) => {
            const p = (t.plan || "starter").toLowerCase();
            const planKey = p === "professional" ? "pro" : p;
            const mrr = t.billingOverride?.mrr != null ? Number(t.billingOverride.mrr) : (plans[planKey] ?? plans.starter);
            return {
                ...t,
                credits: t.credits ? { txCredits: t.credits.txCredits, smsCredits: t.credits.smsCredits } : { txCredits: 0, smsCredits: 0 },
                mrr,
            };
        });
        res.json({ success: true, tenants: tenantsWithMeta });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/tenants/:id — includes admin user and credits
router.get("/:id", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin", "admin"), async (req, res) => {
    try {
        const tenant = await prisma_1.default.tenant.findUnique({
            where: { id: req.params.id },
            include: {
                _count: { select: { members: true } },
                credits: true,
                billingOverride: true,
                users: { where: { role: "admin" }, take: 1, select: { email: true, name: true } },
            },
        });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Tenant not found" });
            return;
        }
        const adminUser = tenant.users[0] ? { email: tenant.users[0].email, name: tenant.users[0].name } : null;
        const { users: _, ...rest } = tenant;
        res.json({ success: true, tenant: { ...rest, adminUser } });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/platform/tenants
router.post("/", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const body = req.body;
        const data = tenantSchema.parse(body);
        const adminUser = body.adminUser ? adminUserSchema.parse(body.adminUser) : null;
        const tenant = await prisma_1.default.tenant.create({ data });
        let createdUser = null;
        if (adminUser) {
            const existing = await prisma_1.default.user.findUnique({ where: { email: adminUser.email } });
            if (existing) {
                await prisma_1.default.tenant.delete({ where: { id: tenant.id } });
                res.status(400).json({ success: false, message: `User with email ${adminUser.email} already exists` });
                return;
            }
            const passwordHash = await bcrypt_1.default.hash(adminUser.password, 12);
            createdUser = await prisma_1.default.user.create({
                data: {
                    email: adminUser.email,
                    passwordHash,
                    name: adminUser.name,
                    role: "admin",
                    tenantId: tenant.id,
                    status: "active",
                },
            });
        }
        await (0, audit_1.createAuditLog)({
            userId: req.user?.userId,
            tenantId: tenant.id,
            action: "CREATE_TENANT",
            entity: "Tenant",
            entityId: tenant.id,
            newData: data,
            ipAddress: req.ip,
        });
        res.status(201).json({ success: true, tenant, adminUser: createdUser ? { id: createdUser.id, email: createdUser.email, name: createdUser.name } : undefined });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PATCH /api/v1/platform/tenants/:id
router.patch("/:id", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const data = tenantSchema.partial().parse(req.body);
        const tenant = await prisma_1.default.tenant.update({ where: { id: req.params.id }, data });
        await (0, audit_1.createAuditLog)({
            userId: req.user?.userId,
            action: "UPDATE_TENANT",
            entity: "Tenant",
            entityId: tenant.id,
            newData: data,
            ipAddress: req.ip,
        });
        res.json({ success: true, tenant });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/tenants/:id/credits
router.get("/:id/credits", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const credits = await prisma_1.default.tenantCredits.findUnique({
            where: { tenantId: req.params.id },
        });
        res.json({ success: true, credits: credits ? { txCredits: credits.txCredits, smsCredits: credits.smsCredits } : { txCredits: 0, smsCredits: 0 } });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/platform/tenants/:id/credits
router.put("/:id/credits", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const { txCredits, smsCredits } = zod_1.z.object({
            txCredits: zod_1.z.number().int().min(0).optional(),
            smsCredits: zod_1.z.number().int().min(0).optional(),
        }).parse(req.body);
        const tenantId = req.params.id;
        const credits = await prisma_1.default.tenantCredits.upsert({
            where: { tenantId },
            update: { ...(txCredits != null && { txCredits }), ...(smsCredits != null && { smsCredits }) },
            create: { tenantId, txCredits: txCredits ?? 0, smsCredits: smsCredits ?? 0 },
        });
        res.json({ success: true, credits: { txCredits: credits.txCredits, smsCredits: credits.smsCredits } });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/tenants/:id/usage
router.get("/:id/usage", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const tenantId = req.params.id;
        const period = req.query.period || new Date().toISOString().slice(0, 7);
        const [memberCount, txnCount, snapshot, loansDisbursed] = await Promise.all([
            prisma_1.default.member.count({ where: { tenantId, status: "active" } }),
            prisma_1.default.transaction.count({ where: { account: { tenantId } } }),
            prisma_1.default.tenantUsageSnapshot.findUnique({ where: { tenantId_period: { tenantId, period } } }),
            prisma_1.default.loan.count({ where: { tenantId, disbursedAt: { not: null } } }),
        ]);
        const userCount = await prisma_1.default.user.count({ where: { tenantId } });
        res.json({
            success: true,
            usage: {
                period,
                activeUsersPeak: snapshot?.activeUsersPeak ?? userCount,
                memberCount,
                txnVolume: snapshot?.txnVolume ?? txnCount,
                storageMb: snapshot?.storageMb ?? 0,
                aiInvocations: snapshot?.aiInvocations ?? 0,
                apiCalls: snapshot?.apiCalls ?? 0,
                loansDisbursed,
            },
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/tenants/:id/modules — modules enabled for tenant's plan
router.get("/:id/modules", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const tenant = await prisma_1.default.tenant.findUnique({ where: { id: req.params.id } });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Tenant not found" });
            return;
        }
        const plan = (tenant.plan || "starter").toLowerCase();
        const cfg = await prisma_1.default.platformConfig.findUnique({ where: { key: "platform.modules.by_tier" } });
        const DEFAULT = { starter: ["sb", "loans", "deposits", "reporting"], pro: ["sb", "loans", "deposits", "reporting", "governance", "compliance"], enterprise: ["sb", "loans", "deposits", "reporting", "governance", "compliance", "ai"] };
        let modules = DEFAULT[plan] ?? DEFAULT.starter;
        if (cfg?.value) {
            try {
                const parsed = JSON.parse(cfg.value);
                modules = parsed[plan] ?? modules;
            }
            catch { /* ignore */ }
        }
        const memberCapCfg = await prisma_1.default.platformConfig.findUnique({ where: { key: "platform.member_cap.by_tier" } });
        const DEFAULT_CAP = { starter: 500, pro: 2000, enterprise: -1 };
        let memberCap = DEFAULT_CAP[plan] ?? 500;
        if (memberCapCfg?.value) {
            try {
                const parsed = JSON.parse(memberCapCfg.value);
                memberCap = parsed[plan] ?? memberCap;
            }
            catch { /* ignore */ }
        }
        res.json({ success: true, modules, memberCap, plan });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PATCH /api/v1/platform/tenants/:id/status
router.patch("/:id/status", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const { status } = zod_1.z.object({ status: zod_1.z.enum(["trial", "active", "suspended", "inactive", "reactivated", "offboarded"]) }).parse(req.body);
        const updateData = { status };
        if (status === "offboarded")
            updateData.offboardedAt = new Date();
        if (status === "reactivated" || status === "active")
            updateData.offboardedAt = null;
        const tenant = await prisma_1.default.tenant.update({ where: { id: req.params.id }, data: updateData });
        res.json({ success: true, tenant });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=tenants.js.map