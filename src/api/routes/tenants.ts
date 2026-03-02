import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

const DEFAULT_PLANS: Record<string, number> = { starter: 1000, pro: 5000, enterprise: 15000 };
async function getPlanMrr(): Promise<Record<string, number>> {
    const cfg = await prisma.platformConfig.findUnique({ where: { key: "billing_plans" } });
    if (!cfg?.value) return DEFAULT_PLANS;
    try {
        const parsed = JSON.parse(cfg.value) as Record<string, number>;
        return { ...DEFAULT_PLANS, ...parsed };
    } catch {
        return DEFAULT_PLANS;
    }
}

const tenantSchema = z.object({
    name: z.string().min(2),
    code: z.string().min(2).max(20),
    district: z.string().optional(),
    state: z.string().optional(),
    regNumber: z.string().optional(),
    plan: z.enum(["starter", "pro", "enterprise"]).default("starter"),
});

const adminUserSchema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
});

// GET /api/v1/platform/tenants — includes credits and mrr (real data)
router.get("/", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const [tenants, plans] = await Promise.all([
            prisma.tenant.findMany({
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/tenants/:id — includes admin user and credits
router.get("/:id", authMiddleware, requireRole("superadmin", "admin"), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenant = await prisma.tenant.findUnique({
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/platform/tenants
router.post("/", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = req.body as Record<string, unknown>;
        const data = tenantSchema.parse(body);
        const adminUser = body.adminUser ? adminUserSchema.parse(body.adminUser) : null;

        const tenant = await prisma.tenant.create({ data });

        let createdUser = null;
        if (adminUser) {
            const existing = await prisma.user.findUnique({ where: { email: adminUser.email } });
            if (existing) {
                await prisma.tenant.delete({ where: { id: tenant.id } });
                res.status(400).json({ success: false, message: `User with email ${adminUser.email} already exists` });
                return;
            }
            const passwordHash = await bcrypt.hash(adminUser.password, 12);
            createdUser = await prisma.user.create({
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

        await createAuditLog({
            userId: req.user?.userId,
            tenantId: tenant.id,
            action: "CREATE_TENANT",
            entity: "Tenant",
            entityId: tenant.id,
            newData: data,
            ipAddress: req.ip,
        });

        res.status(201).json({ success: true, tenant, adminUser: createdUser ? { id: createdUser.id, email: createdUser.email, name: createdUser.name } : undefined });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PATCH /api/v1/platform/tenants/:id
router.patch("/:id", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const data = tenantSchema.partial().parse(req.body);
        const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data });

        await createAuditLog({
            userId: req.user?.userId,
            action: "UPDATE_TENANT",
            entity: "Tenant",
            entityId: tenant.id,
            newData: data,
            ipAddress: req.ip,
        });

        res.json({ success: true, tenant });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/tenants/:id/credits
router.get("/:id/credits", authMiddleware, requireRole("superadmin"), async (req: Request, res: Response): Promise<void> => {
    try {
        const credits = await prisma.tenantCredits.findUnique({
            where: { tenantId: req.params.id },
        });
        res.json({ success: true, credits: credits ? { txCredits: credits.txCredits, smsCredits: credits.smsCredits } : { txCredits: 0, smsCredits: 0 } });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/tenants/:id/credits
router.put("/:id/credits", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { txCredits, smsCredits } = z.object({
            txCredits: z.number().int().min(0).optional(),
            smsCredits: z.number().int().min(0).optional(),
        }).parse(req.body);
        const tenantId = req.params.id;
        const credits = await prisma.tenantCredits.upsert({
            where: { tenantId },
            update: { ...(txCredits != null && { txCredits }), ...(smsCredits != null && { smsCredits }) },
            create: { tenantId, txCredits: txCredits ?? 0, smsCredits: smsCredits ?? 0 },
        });
        res.json({ success: true, credits: { txCredits: credits.txCredits, smsCredits: credits.smsCredits } });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/tenants/:id/usage
router.get("/:id/usage", authMiddleware, requireRole("superadmin"), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.params.id;
        const period = (req.query.period as string) || new Date().toISOString().slice(0, 7);
        const [memberCount, txnCount, snapshot, loansDisbursed] = await Promise.all([
            prisma.member.count({ where: { tenantId, status: "active" } }),
            prisma.transaction.count({ where: { account: { tenantId } } }),
            prisma.tenantUsageSnapshot.findUnique({ where: { tenantId_period: { tenantId, period } } }),
            prisma.loan.count({ where: { tenantId, disbursedAt: { not: null } } }),
        ]);
        const userCount = await prisma.user.count({ where: { tenantId } });
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
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/tenants/:id/modules — modules enabled for tenant's plan
router.get("/:id/modules", authMiddleware, requireRole("superadmin"), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Tenant not found" });
            return;
        }
        const plan = (tenant.plan || "starter").toLowerCase();
        const cfg = await prisma.platformConfig.findUnique({ where: { key: "platform.modules.by_tier" } });
        const DEFAULT = { starter: ["sb", "loans", "deposits", "reporting"], pro: ["sb", "loans", "deposits", "reporting", "governance", "compliance"], enterprise: ["sb", "loans", "deposits", "reporting", "governance", "compliance", "ai"] };
        let modules: string[] = DEFAULT[plan as keyof typeof DEFAULT] ?? DEFAULT.starter;
        if (cfg?.value) {
            try {
                const parsed = JSON.parse(cfg.value) as Record<string, string[]>;
                modules = parsed[plan] ?? modules;
            } catch { /* ignore */ }
        }
        const memberCapCfg = await prisma.platformConfig.findUnique({ where: { key: "platform.member_cap.by_tier" } });
        const DEFAULT_CAP = { starter: 500, pro: 2000, enterprise: -1 };
        let memberCap = DEFAULT_CAP[plan as keyof typeof DEFAULT_CAP] ?? 500;
        if (memberCapCfg?.value) {
            try {
                const parsed = JSON.parse(memberCapCfg.value) as Record<string, number>;
                memberCap = parsed[plan] ?? memberCap;
            } catch { /* ignore */ }
        }
        res.json({ success: true, modules, memberCap, plan });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PATCH /api/v1/platform/tenants/:id/status
router.patch("/:id/status", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { status } = z.object({ status: z.enum(["trial", "active", "suspended", "inactive", "reactivated", "offboarded"]) }).parse(req.body);
        const updateData: Record<string, unknown> = { status };
        if (status === "offboarded") updateData.offboardedAt = new Date();
        if (status === "reactivated" || status === "active") updateData.offboardedAt = null;
        const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data: updateData });
        res.json({ success: true, tenant });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
