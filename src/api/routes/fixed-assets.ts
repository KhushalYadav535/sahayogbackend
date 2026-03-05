import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";
import { createAuditLog } from "../../db/audit";
import { postGl, currentPeriod } from "../../lib/gl-posting";
import {
    DEPRECIATION_RULES,
    getDeprecRule,
    computeDepreciation,
    DEPRECIATION_RULES as DR,
} from "../../lib/coa-rules";

const router = Router();

// ─── GET /api/v1/fixed-assets ─────────────────────────────────────────────────
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { assetClass, disposed, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where: Record<string, unknown> = { tenantId };
        if (assetClass) where.assetClass = assetClass.toUpperCase();
        if (disposed === "true") where.disposedAt = { not: null };
        if (disposed === "false") where.disposedAt = null;

        const [assets, total] = await Promise.all([
            prisma.fixedAsset.findMany({ where, skip, take: parseInt(limit), orderBy: { purchaseDate: "desc" } }),
            prisma.fixedAsset.count({ where }),
        ]);

        res.json({ success: true, assets, total });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/fixed-assets — Create fixed asset ──────────────────────────
router.post("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z.object({
            name: z.string().min(1),
            assetClass: z.enum(["BUILDING", "FURNITURE", "COMPUTER", "VEHICLE", "EQUIPMENT"]),
            purchaseDate: z.string().transform((s) => new Date(s)),
            cost: z.number().positive(),
            depreciationMethod: z.enum(["SLM", "WDV"]).optional(),
            depreciationRate: z.number().min(0).max(1).optional(),
        }).parse(req.body);

        // Pick rate from CoA rules if not overridden
        const rule = getDeprecRule(data.assetClass);
        const depreciationRate = data.depreciationRate ?? rule?.rate ?? 0.10;
        const depreciationMethod = data.depreciationMethod ?? rule?.method ?? "SLM";

        const asset = await prisma.fixedAsset.create({
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

        await createAuditLog({
            tenantId,
            userId: req.user?.userId,
            action: "FIXED_ASSET_CREATE",
            entity: "FixedAsset",
            entityId: asset.id,
        });

        res.status(201).json({ success: true, asset, appliedRule: rule });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, issues: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/fixed-assets/:id ────────────────────────────────────────────
router.get("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const asset = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, tenantId } });
        if (!asset) {
            res.status(404).json({ success: false, message: "Asset not found" });
            return;
        }
        res.json({ success: true, asset });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/fixed-assets/:id/depreciate — Run depreciation ─────────────
router.post("/:id/depreciate", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();

        const asset = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, tenantId } });
        if (!asset) {
            res.status(404).json({ success: false, message: "Asset not found" });
            return;
        }
        if (asset.disposedAt) {
            res.status(400).json({ success: false, message: "Cannot depreciate a disposed asset" });
            return;
        }

        const rule = getDeprecRule(asset.assetClass) ?? {
            assetClass: asset.assetClass,
            rate: Number(asset.depreciationRate),
            method: asset.depreciationMethod as "SLM" | "WDV",
            glCreditCode: "08-03-0002",
        };

        const depreciation = computeDepreciation(
            Number(asset.cost),
            Number(asset.accumulatedDepreciation),
            rule
        );

        if (depreciation <= 0 || Number(asset.netBookValue) <= 0) {
            res.status(400).json({ success: false, message: "Asset is fully depreciated" });
            return;
        }

        const newAccumulated = Number(asset.accumulatedDepreciation) + depreciation;
        const newNetBook = Math.max(0, Number(asset.cost) - newAccumulated);

        await prisma.fixedAsset.update({
            where: { id: asset.id },
            data: {
                accumulatedDepreciation: newAccumulated,
                netBookValue: newNetBook,
            },
        });

        // COA: GL — DR 13-02-0007 (Depreciation Expense) / CR 08-xx-xxxx (Accumulated Depreciation)
        await postGl(tenantId, "DEPRECIATION", depreciation,
            `Annual depreciation — ${asset.name} (${asset.assetClass})`, period,
            { accumGlCode: rule.glCreditCode });

        res.json({
            success: true,
            message: "Depreciation posted",
            assetId: asset.id,
            depreciation,
            accumulatedDepreciation: newAccumulated,
            netBookValue: newNetBook,
            glCreditCode: rule.glCreditCode,
        });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── POST /api/v1/fixed-assets/:id/dispose — Dispose asset ───────────────────
router.post("/:id/dispose", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const period = currentPeriod();

        const { saleProceeds } = z.object({
            saleProceeds: z.number().min(0),
        }).parse(req.body);

        const asset = await prisma.fixedAsset.findFirst({ where: { id: req.params.id, tenantId } });
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

        await prisma.fixedAsset.update({
            where: { id: asset.id },
            data: {
                disposedAt: new Date(),
                disposalProceeds: saleProceeds,
                netBookValue: 0,
            },
        });

        // GL: Post profit or loss on disposal
        if (profitOrLoss > 0) {
            await postGl(tenantId, "ASSET_DISPOSAL_PROFIT", profitOrLoss,
                `Asset disposal profit — ${asset.name}`, period);
        } else if (profitOrLoss < 0) {
            await postGl(tenantId, "ASSET_DISPOSAL_LOSS", Math.abs(profitOrLoss),
                `Asset disposal loss — ${asset.name}`, period);
        }

        await createAuditLog({
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
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, issues: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── GET /api/v1/fixed-assets/depreciation-schedule — View CoA rules ─────────
router.get("/schedule/depreciation-rates", authMiddleware, requireTenant, async (_req: AuthRequest, res: Response): Promise<void> => {
    res.json({
        success: true,
        rules: DEPRECIATION_RULES.map((r) => ({
            assetClass: r.assetClass,
            annualRatePercent: (r.rate * 100).toFixed(2) + "%",
            method: r.method,
            glCreditCode: r.glCreditCode,
        })),
    });
});

export default router;
