import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/v1/suspense — list suspense entries
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const entries = await prisma.suspenseEntry.findMany({
            where: { tenantId },
            orderBy: [{ receiptDate: "desc" }, { createdAt: "desc" }],
        });

        const now = new Date();
        const rows = entries.map((e) => {
            const receiptDate = new Date(e.receiptDate);
            const openFor = e.status === "OPEN" ? Math.floor((now.getTime() - receiptDate.getTime()) / (24 * 60 * 60 * 1000)) : 0;
            let status = e.status;
            if (status === "OPEN" && openFor > 15) status = "OVERDUE";
            return {
                id: e.id,
                suspenseNumber: e.suspenseNumber,
                amount: Number(e.amount),
                receiptDate: e.receiptDate.toISOString(),
                narration: e.narration,
                status,
                openFor,
                targetGlCode: e.targetGlCode,
                targetGlName: e.targetGlName,
                clearingNote: e.clearingNote,
                clearedAt: e.clearedAt?.toISOString(),
            };
        });

        res.json({ success: true, entries: rows });
    } catch (err) {
        console.error("[Suspense GET]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/suspense — add suspense entry
router.post("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z
            .object({
                amount: z.number().positive(),
                receiptDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
                narration: z.string().optional(),
            })
            .parse(req.body);

        const count = await prisma.suspenseEntry.count({ where: { tenantId } });
        const suspenseNumber = `SUS-${String(count + 1).padStart(3, "0")}`;

        const entry = await prisma.suspenseEntry.create({
            data: {
                tenantId,
                suspenseNumber,
                amount: data.amount,
                receiptDate: new Date(data.receiptDate),
                narration: data.narration || null,
            },
        });

        res.status(201).json({
            success: true,
            entry: {
                id: entry.id,
                suspenseNumber: entry.suspenseNumber,
                amount: Number(entry.amount),
                receiptDate: entry.receiptDate.toISOString(),
                narration: entry.narration,
                status: entry.status,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors, message: err.errors.map((e) => e.message).join("; ") });
            return;
        }
        console.error("[Suspense POST]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/suspense/:id/clear — clear suspense to GL account
router.post("/:id/clear", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z
            .object({
                targetGlCode: z.string().min(1),
                targetGlName: z.string().min(1),
                clearingNote: z.string().min(1),
            })
            .parse(req.body);

        const entry = await prisma.suspenseEntry.findFirst({
            where: { id: req.params.id, tenantId },
        });
        if (!entry) {
            res.status(404).json({ success: false, message: "Suspense entry not found" });
            return;
        }
        if (entry.status === "CLEARED") {
            res.status(400).json({ success: false, message: "Already cleared" });
            return;
        }

        const updated = await prisma.suspenseEntry.update({
            where: { id: entry.id },
            data: {
                status: "CLEARED",
                targetGlCode: data.targetGlCode,
                targetGlName: data.targetGlName,
                clearingNote: data.clearingNote,
                clearedAt: new Date(),
                clearedBy: req.user?.userId,
            },
        });

        res.json({
            success: true,
            entry: {
                id: updated.id,
                suspenseNumber: updated.suspenseNumber,
                status: updated.status,
                targetGlCode: updated.targetGlCode,
                targetGlName: updated.targetGlName,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors, message: err.errors.map((e) => e.message).join("; ") });
            return;
        }
        console.error("[Suspense Clear]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
