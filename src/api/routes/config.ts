import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";

const router = Router();

const PLATFORM_MDA_DEFAULT = {
    fdrTdsRate: 10,
    minorAge: 18,
    loanProvisionMap: { standard: 0, sma: 0.15, sub_standard: 0.25, doubtful_1: 0.4, doubtful_2: 0.4, doubtful_3: 1, loss: 1 },
};

async function getPlatformMda(): Promise<typeof PLATFORM_MDA_DEFAULT> {
    const cfg = await prisma.platformConfig.findUnique({ where: { key: "platform.mda.params" } });
    if (!cfg?.value) return PLATFORM_MDA_DEFAULT;
    try {
        return { ...PLATFORM_MDA_DEFAULT, ...JSON.parse(cfg.value) };
    } catch {
        return PLATFORM_MDA_DEFAULT;
    }
}

// MT-003: GET /api/v1/config/mda — tenant MDA (platform + tenant overrides)
router.get("/mda", authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant context required" });
            return;
        }
        const platform = await getPlatformMda();
        const tenantCfg = await prisma.systemConfig.findUnique({
            where: { tenantId_key: { tenantId, key: "tenant.mda" } },
        });
        const tenantMda = tenantCfg?.value ? (() => {
            try {
                return JSON.parse(tenantCfg.value) as Record<string, unknown>;
            } catch {
                return {};
            }
        })() : {};
        const merged = { ...platform, ...tenantMda };
        res.json({ success: true, mda: merged });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// MT-003: PUT /api/v1/config/mda — save tenant MDA override + version
router.put("/mda", authMiddleware, requireRole("admin", "staff"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId!;
        const body = z.object({
            fdrTdsRate: z.number().min(0).max(100).optional(),
            minorAge: z.number().min(1).max(100).optional(),
            loanProvisionMap: z.record(z.string(), z.number()).optional(),
        }).parse(req.body);

        const platform = await getPlatformMda();
        const tenantCfg = await prisma.systemConfig.findUnique({
            where: { tenantId_key: { tenantId, key: "tenant.mda" } },
        });
        const current = tenantCfg?.value ? JSON.parse(tenantCfg.value) : {};
        const updated = { ...current, ...body };
        const valueStr = JSON.stringify(updated);

        await prisma.$transaction(async (tx) => {
            await tx.systemConfig.upsert({
                where: { tenantId_key: { tenantId, key: "tenant.mda" } },
                update: { value: valueStr, label: "Tenant MDA overrides" },
                create: { tenantId, key: "tenant.mda", value: valueStr, label: "Tenant MDA overrides" },
            });
            const maxVersion = await tx.tenantConfigVersion.aggregate({
                where: { tenantId, key: "mda" },
                _max: { version: true },
            });
            const nextVer = (maxVersion._max.version ?? 0) + 1;
            await tx.tenantConfigVersion.create({
                data: { tenantId, key: "mda", value: valueStr, version: nextVer, createdBy: req.user?.userId },
            });
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "UPDATE_MDA",
            entity: "TenantConfig",
            entityId: "mda",
            newData: body,
            ipAddress: req.ip,
        });

        const merged = { ...platform, ...updated };
        res.json({ success: true, mda: merged });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// MT-003: GET /api/v1/config/mda/versions — list versions for rollback
router.get("/mda/versions", authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant context required" });
            return;
        }
        const versions = await prisma.tenantConfigVersion.findMany({
            where: { tenantId, key: "mda" },
            orderBy: { version: "desc" },
            take: 20,
        });
        res.json({ success: true, versions });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// MT-003: POST /api/v1/config/mda/rollback/:id — rollback to version
router.post("/mda/rollback/:id", authMiddleware, requireRole("admin", "staff"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId!;
        const versionRec = await prisma.tenantConfigVersion.findFirst({
            where: { id: req.params.id, tenantId, key: "mda" },
        });
        if (!versionRec) {
            res.status(404).json({ success: false, message: "Version not found" });
            return;
        }

        await prisma.systemConfig.upsert({
            where: { tenantId_key: { tenantId, key: "tenant.mda" } },
            update: { value: versionRec.value },
            create: { tenantId, key: "tenant.mda", value: versionRec.value, label: "Tenant MDA overrides" },
        });

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "ROLLBACK_MDA",
            entity: "TenantConfig",
            entityId: versionRec.id,
            newData: { rolledBackToVersion: versionRec.version },
            ipAddress: req.ip,
        });

        const platform = await getPlatformMda();
        const merged = { ...platform, ...JSON.parse(versionRec.value) };
        res.json({ success: true, mda: merged, message: `Rolled back to version ${versionRec.version}` });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/config/:key  (tenant-scoped)
router.get("/:key", authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant context required" });
            return;
        }
        const config = await prisma.systemConfig.findUnique({
            where: { tenantId_key: { tenantId, key: req.params.key } },
        });
        if (!config) {
            res.status(404).json({ success: false, message: "Config key not found" });
            return;
        }
        res.json({ success: true, config });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/config  (all keys for tenant)
router.get("/", authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant context required" });
            return;
        }
        const configs = await prisma.systemConfig.findMany({ where: { tenantId } });
        res.json({ success: true, configs });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/config/:key
router.put("/:key", authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user?.tenantId;
        if (!tenantId) {
            res.status(403).json({ success: false, message: "Tenant context required" });
            return;
        }
        const { value, label } = z.object({ value: z.string(), label: z.string().optional() }).parse(req.body);

        const config = await prisma.systemConfig.upsert({
            where: { tenantId_key: { tenantId, key: req.params.key } },
            update: { value, label },
            create: { tenantId, key: req.params.key, value, label },
        });
        res.json({ success: true, config });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
