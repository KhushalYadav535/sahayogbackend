"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const audit_1 = require("../../db/audit");
const gl_posting_1 = require("../../lib/gl-posting");
const coa_rules_1 = require("../../lib/coa-rules");
const router = (0, express_1.Router)();
// ─── GET /api/v1/fixed-assets ─────────────────────────────────────────────────
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { assetClass, disposed, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (assetClass)
            where.assetClass = assetClass.toUpperCase();
        if (disposed === "true")
            where.disposedAt = { not: null };
        if (disposed === "false")
            where.disposedAt = null;
        const [assets, total] = await Promise.all([
            prisma_1.default.fixedAsset.findMany({ where, skip, take: parseInt(limit), orderBy: { purchaseDate: "desc" } }),
            prisma_1.default.fixedAsset.count({ where }),
        ]);
        res.json({ success: true, assets, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/fixed-assets — Create fixed asset ──────────────────────────
router.post("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            name: zod_1.z.string().min(1),
            assetClass: zod_1.z.enum(["BUILDING", "FURNITURE", "COMPUTER", "VEHICLE", "EQUIPMENT"]),
            purchaseDate: zod_1.z.string().transform((s) => new Date(s)),
            cost: zod_1.z.number().positive(),
            depreciationMethod: zod_1.z.enum(["SLM", "WDV"]).optional(),
            depreciationRate: zod_1.z.number().min(0).max(1).optional(),
        }).parse(req.body);
        // Pick rate from CoA rules if not overridden
        const rule = (0, coa_rules_1.getDeprecRule)(data.assetClass);
        const depreciationRate = data.depreciationRate ?? rule?.rate ?? 0.10;
        const depreciationMethod = data.depreciationMethod ?? rule?.method ?? "SLM";
        const asset = await prisma_1.default.fixedAsset.create({
            data: {
                tenantId,
                name: data.name,
                assetClass: data.assetClass,
                purchaseDate: data.purchaseDate,
                cost: data.cost,
                depreciationMethod,
                depreciationRate,
                accumulatedDepreciation: 0,
                netBookValue: data.cost,
            },
        });
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "FIXED_ASSET_CREATE",
            entity: "FixedAsset",
            entityId: asset.id,
        });
        res.status(201).json({ success: true, asset, appliedRule: rule });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, issues: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/fixed-assets/:id ────────────────────────────────────────────
router.get("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const asset = await prisma_1.default.fixedAsset.findFirst({ where: { id: req.params.id, tenantId } });
        if (!asset) {
            res.status(404).json({ success: false, message: "Asset not found" });
            return;
        }
        res.json({ success: true, asset });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/fixed-assets/:id/depreciate — Run depreciation ─────────────
router.post("/:id/depreciate", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const asset = await prisma_1.default.fixedAsset.findFirst({ where: { id: req.params.id, tenantId } });
        if (!asset) {
            res.status(404).json({ success: false, message: "Asset not found" });
            return;
        }
        if (asset.disposedAt) {
            res.status(400).json({ success: false, message: "Cannot depreciate a disposed asset" });
            return;
        }
        const rule = (0, coa_rules_1.getDeprecRule)(asset.assetClass) ?? {
            assetClass: asset.assetClass,
            rate: Number(asset.depreciationRate),
            method: asset.depreciationMethod,
            glCreditCode: "08-03-0002",
        };
        const depreciation = (0, coa_rules_1.computeDepreciation)(Number(asset.cost), Number(asset.accumulatedDepreciation), rule);
        if (depreciation <= 0 || Number(asset.netBookValue) <= 0) {
            res.status(400).json({ success: false, message: "Asset is fully depreciated" });
            return;
        }
        const newAccumulated = Number(asset.accumulatedDepreciation) + depreciation;
        const newNetBook = Math.max(0, Number(asset.cost) - newAccumulated);
        await prisma_1.default.fixedAsset.update({
            where: { id: asset.id },
            data: {
                accumulatedDepreciation: newAccumulated,
                netBookValue: newNetBook,
            },
        });
        // COA: GL — DR 13-02-0007 (Depreciation Expense) / CR 08-xx-xxxx (Accumulated Depreciation)
        await (0, gl_posting_1.postGl)(tenantId, "DEPRECIATION", depreciation, `Annual depreciation — ${asset.name} (${asset.assetClass})`, period, { accumGlCode: rule.glCreditCode });
        res.json({
            success: true,
            message: "Depreciation posted",
            assetId: asset.id,
            depreciation,
            accumulatedDepreciation: newAccumulated,
            netBookValue: newNetBook,
            glCreditCode: rule.glCreditCode,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── POST /api/v1/fixed-assets/:id/dispose — Dispose asset ───────────────────
router.post("/:id/dispose", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const period = (0, gl_posting_1.currentPeriod)();
        const { saleProceeds } = zod_1.z.object({
            saleProceeds: zod_1.z.number().min(0),
        }).parse(req.body);
        const asset = await prisma_1.default.fixedAsset.findFirst({ where: { id: req.params.id, tenantId } });
        if (!asset) {
            res.status(404).json({ success: false, message: "Asset not found" });
            return;
        }
        if (asset.disposedAt) {
            res.status(400).json({ success: false, message: "Asset already disposed" });
            return;
        }
        const netBook = Number(asset.netBookValue);
        const profitOrLoss = saleProceeds - netBook;
        await prisma_1.default.fixedAsset.update({
            where: { id: asset.id },
            data: {
                disposedAt: new Date(),
                disposalProceeds: saleProceeds,
                netBookValue: 0,
            },
        });
        // GL: Post profit or loss on disposal
        if (profitOrLoss > 0) {
            await (0, gl_posting_1.postGl)(tenantId, "ASSET_DISPOSAL_PROFIT", profitOrLoss, `Asset disposal profit — ${asset.name}`, period);
        }
        else if (profitOrLoss < 0) {
            await (0, gl_posting_1.postGl)(tenantId, "ASSET_DISPOSAL_LOSS", Math.abs(profitOrLoss), `Asset disposal loss — ${asset.name}`, period);
        }
        await (0, audit_1.createAuditLog)({
            tenantId,
            userId: req.user?.userId,
            action: "FIXED_ASSET_DISPOSE",
            entity: "FixedAsset",
            entityId: asset.id,
            newData: { saleProceeds, profitOrLoss },
        });
        res.json({
            success: true,
            message: "Asset disposed",
            netBookValue: netBook,
            saleProceeds,
            profitOrLoss: Math.abs(profitOrLoss),
            glPosted: profitOrLoss > 0 ? "ASSET_DISPOSAL_PROFIT" : profitOrLoss < 0 ? "ASSET_DISPOSAL_LOSS" : "none",
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, issues: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── GET /api/v1/fixed-assets/depreciation-schedule — View CoA rules ─────────
router.get("/schedule/depreciation-rates", auth_1.authMiddleware, auth_1.requireTenant, async (_req, res) => {
    res.json({
        success: true,
        rules: coa_rules_1.DEPRECIATION_RULES.map((r) => ({
            assetClass: r.assetClass,
            annualRatePercent: (r.rate * 100).toFixed(2) + "%",
            method: r.method,
            glCreditCode: r.glCreditCode,
        })),
    });
});
exports.default = router;
//# sourceMappingURL=fixed-assets.js.map