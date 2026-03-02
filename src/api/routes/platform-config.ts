/**
 * Platform config - super admin: modules per tier, member cap, MDA params.
 * BRD: modules.enabled per tier, Platform-scope MDA parameters.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

const DEFAULT_MODULES: Record<string, string[]> = {
    starter: ["sb", "loans", "deposits", "reporting"],
    pro: ["sb", "loans", "deposits", "reporting", "governance", "compliance"],
    enterprise: ["sb", "loans", "deposits", "reporting", "governance", "compliance", "ai"],
};

const DEFAULT_MEMBER_CAP: Record<string, number> = {
    starter: 500,
    pro: 2000,
    enterprise: -1, // unlimited
};

const DEFAULT_MDA = {
    fdrTdsRate: 10,
    minorAge: 18,
    loanProvisionMap: {
        standard: 0,
        sma: 0.15,
        sub_standard: 0.25,
        doubtful_1: 0.4,
        doubtful_2: 0.4,
        doubtful_3: 1,
        loss: 1,
    },
};

async function getPlatformJson<T>(key: string, defaultValue: T): Promise<T> {
    const cfg = await prisma.platformConfig.findUnique({ where: { key } });
    if (!cfg?.value) return defaultValue;
    try {
        return JSON.parse(cfg.value) as T;
    } catch {
        return defaultValue;
    }
}

async function setPlatformJson(key: string, value: unknown, label: string): Promise<void> {
    await prisma.platformConfig.upsert({
        where: { key },
        update: { value: JSON.stringify(value), label },
        create: { key, value: JSON.stringify(value), label },
    });
}

// GET /api/v1/platform/config/modules
router.get("/modules", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const modules = await getPlatformJson<Record<string, string[]>>("platform.modules.by_tier", DEFAULT_MODULES);
        const memberCap = await getPlatformJson<Record<string, number>>("platform.member_cap.by_tier", DEFAULT_MEMBER_CAP);
        res.json({ success: true, modules, memberCap });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/config/modules
router.put("/modules", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const { modules, memberCap } = z.object({
            modules: z.record(z.string(), z.array(z.string())).optional(),
            memberCap: z.record(z.string(), z.number()).optional(),
        }).parse(req.body);
        if (modules) await setPlatformJson("platform.modules.by_tier", modules, "Modules per tier");
        if (memberCap) await setPlatformJson("platform.member_cap.by_tier", memberCap, "Member cap per tier");
        const out = {
            modules: modules ?? (await getPlatformJson<Record<string, string[]>>("platform.modules.by_tier", DEFAULT_MODULES)),
            memberCap: memberCap ?? (await getPlatformJson<Record<string, number>>("platform.member_cap.by_tier", DEFAULT_MEMBER_CAP)),
        };
        res.json({ success: true, ...out });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/config/mda
router.get("/mda", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const mda = await getPlatformJson<typeof DEFAULT_MDA>("platform.mda.params", DEFAULT_MDA);
        res.json({ success: true, mda });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/platform/config/ai
router.get("/ai", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const ai = await getPlatformJson<{ modelVersion: string; rollbackVersion?: string }>("platform.ai.config", {
            modelVersion: "gpt-4o-mini",
            rollbackVersion: undefined,
        });
        res.json({ success: true, ai });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/config/ai
router.put("/ai", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = z
            .object({
                modelVersion: z.string().optional(),
                rollbackVersion: z.string().optional().nullable(),
            })
            .parse(req.body);
        const current = await getPlatformJson<{ modelVersion: string; rollbackVersion?: string }>("platform.ai.config", {
            modelVersion: "gpt-4o-mini",
            rollbackVersion: undefined,
        });
        const updated = { ...current, ...body };
        await setPlatformJson("platform.ai.config", updated, "AI model configuration");
        res.json({ success: true, ai: updated });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/config/mda
router.put("/mda", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = z.object({
            fdrTdsRate: z.number().min(0).max(100).optional(),
            minorAge: z.number().min(1).max(100).optional(),
            loanProvisionMap: z.record(z.string(), z.number()).optional(),
        }).parse(req.body);
        const current = await getPlatformJson<typeof DEFAULT_MDA>("platform.mda.params", DEFAULT_MDA);
        const updated = { ...current, ...body };
        await setPlatformJson("platform.mda.params", updated, "Platform MDA parameters");
        res.json({ success: true, mda: updated });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
