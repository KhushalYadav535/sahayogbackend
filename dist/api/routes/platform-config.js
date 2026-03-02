"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Platform config - super admin: modules per tier, member cap, MDA params.
 * BRD: modules.enabled per tier, Platform-scope MDA parameters.
 */
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const DEFAULT_MODULES = {
    starter: ["sb", "loans", "deposits", "reporting"],
    pro: ["sb", "loans", "deposits", "reporting", "governance", "compliance"],
    enterprise: ["sb", "loans", "deposits", "reporting", "governance", "compliance", "ai"],
};
const DEFAULT_MEMBER_CAP = {
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
async function getPlatformJson(key, defaultValue) {
    const cfg = await prisma_1.default.platformConfig.findUnique({ where: { key } });
    if (!cfg?.value)
        return defaultValue;
    try {
        return JSON.parse(cfg.value);
    }
    catch {
        return defaultValue;
    }
}
async function setPlatformJson(key, value, label) {
    await prisma_1.default.platformConfig.upsert({
        where: { key },
        update: { value: JSON.stringify(value), label },
        create: { key, value: JSON.stringify(value), label },
    });
}
// GET /api/v1/platform/config/modules
router.get("/modules", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (_req, res) => {
    try {
        const modules = await getPlatformJson("platform.modules.by_tier", DEFAULT_MODULES);
        const memberCap = await getPlatformJson("platform.member_cap.by_tier", DEFAULT_MEMBER_CAP);
        res.json({ success: true, modules, memberCap });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/platform/config/modules
router.put("/modules", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const { modules, memberCap } = zod_1.z.object({
            modules: zod_1.z.record(zod_1.z.string(), zod_1.z.array(zod_1.z.string())).optional(),
            memberCap: zod_1.z.record(zod_1.z.string(), zod_1.z.number()).optional(),
        }).parse(req.body);
        if (modules)
            await setPlatformJson("platform.modules.by_tier", modules, "Modules per tier");
        if (memberCap)
            await setPlatformJson("platform.member_cap.by_tier", memberCap, "Member cap per tier");
        const out = {
            modules: modules ?? (await getPlatformJson("platform.modules.by_tier", DEFAULT_MODULES)),
            memberCap: memberCap ?? (await getPlatformJson("platform.member_cap.by_tier", DEFAULT_MEMBER_CAP)),
        };
        res.json({ success: true, ...out });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/config/mda
router.get("/mda", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (_req, res) => {
    try {
        const mda = await getPlatformJson("platform.mda.params", DEFAULT_MDA);
        res.json({ success: true, mda });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/platform/config/ai
router.get("/ai", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (_req, res) => {
    try {
        const ai = await getPlatformJson("platform.ai.config", {
            modelVersion: "gpt-4o-mini",
            rollbackVersion: undefined,
        });
        res.json({ success: true, ai });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/platform/config/ai
router.put("/ai", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const body = zod_1.z
            .object({
            modelVersion: zod_1.z.string().optional(),
            rollbackVersion: zod_1.z.string().optional().nullable(),
        })
            .parse(req.body);
        const current = await getPlatformJson("platform.ai.config", {
            modelVersion: "gpt-4o-mini",
            rollbackVersion: undefined,
        });
        const updated = { ...current, ...body };
        await setPlatformJson("platform.ai.config", updated, "AI model configuration");
        res.json({ success: true, ai: updated });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PUT /api/v1/platform/config/mda
router.put("/mda", auth_1.authMiddleware, (0, auth_1.requireRole)("superadmin"), async (req, res) => {
    try {
        const body = zod_1.z.object({
            fdrTdsRate: zod_1.z.number().min(0).max(100).optional(),
            minorAge: zod_1.z.number().min(1).max(100).optional(),
            loanProvisionMap: zod_1.z.record(zod_1.z.string(), zod_1.z.number()).optional(),
        }).parse(req.body);
        const current = await getPlatformJson("platform.mda.params", DEFAULT_MDA);
        const updated = { ...current, ...body };
        await setPlatformJson("platform.mda.params", updated, "Platform MDA parameters");
        res.json({ success: true, mda: updated });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=platform-config.js.map