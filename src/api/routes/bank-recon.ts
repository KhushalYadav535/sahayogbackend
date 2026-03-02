import { Router, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// Parse CSV content - simple parser for bank statement format
// Expected: date,narration,amount,type (or similar)
function parseCsvContent(content: string): { date: string; narration: string; amount: number; type: string }[] {
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
    const dateIdx = header.findIndex((h) => h.includes("date"));
    const narrIdx = header.findIndex((h) => h.includes("narr") || h.includes("desc") || h.includes("particular"));
    const amtIdx = header.findIndex((h) => h.includes("amount") || h.includes("debit") || h.includes("credit"));
    const typeIdx = header.findIndex((h) => h === "type" || h === "cr" || h === "dr");

    const rows: { date: string; narration: string; amount: number; type: string }[] = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(",").map((c) => c.trim().replace(/^["']|["']$/g, ""));
        const date = dateIdx >= 0 ? cells[dateIdx] : "";
        const narration = narrIdx >= 0 ? cells[narrIdx] : cells.join(" ");
        let amount = 0;
        if (amtIdx >= 0 && cells[amtIdx]) {
            amount = parseFloat(cells[amtIdx].replace(/[^\d.-]/g, "")) || 0;
        }
        let type = "CR";
        if (typeIdx >= 0 && cells[typeIdx]) {
            const t = (cells[typeIdx] || "").toUpperCase();
            type = t.startsWith("D") || t === "DR" ? "DR" : "CR";
        } else if (header.some((h) => h.includes("debit")) && header.some((h) => h.includes("credit"))) {
            const debitIdx = header.findIndex((h) => h.includes("debit"));
            const creditIdx = header.findIndex((h) => h.includes("credit"));
            const debit = parseFloat((cells[debitIdx] || "0").replace(/[^\d.-]/g, "")) || 0;
            const credit = parseFloat((cells[creditIdx] || "0").replace(/[^\d.-]/g, "")) || 0;
            amount = debit > 0 ? debit : credit;
            type = debit > 0 ? "DR" : "CR";
        }
        if (date && amount !== 0) {
            rows.push({ date, narration, amount, type });
        }
    }
    return rows;
}

// POST /api/v1/bank-recon/upload — upload bank statement (CSV content in body)
router.post("/upload", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z
            .object({
                fileName: z.string().min(1),
                csvContent: z.string().min(1),
                bankName: z.string().optional(),
            })
            .parse(req.body);

        const rows = parseCsvContent(data.csvContent);
        if (rows.length === 0) {
            res.status(400).json({ success: false, message: "No valid transactions found in CSV" });
            return;
        }

        const dates = rows.map((r) => new Date(r.date)).filter((d) => !isNaN(d.getTime()));
        const periodStart = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : new Date();
        const periodEnd = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : new Date();

        const upload = await prisma.bankStatementUpload.create({
            data: {
                tenantId,
                fileName: data.fileName,
                periodStart,
                periodEnd,
                bankName: data.bankName || null,
            },
        });

        const toCreate = rows
            .map((r) => {
                const d = new Date(r.date);
                if (isNaN(d.getTime())) return null;
                return {
                    uploadId: upload.id,
                    tenantId,
                    entryDate: d,
                    narration: r.narration,
                    amount: r.amount,
                    type: r.type,
                };
            })
            .filter((x): x is { uploadId: string; tenantId: string; entryDate: Date; narration: string; amount: number; type: string } => x !== null);

        await prisma.bankStatementEntry.createMany({ data: toCreate });

        res.status(201).json({
            success: true,
            upload: {
                id: upload.id,
                fileName: upload.fileName,
                periodStart: upload.periodStart.toISOString(),
                periodEnd: upload.periodEnd.toISOString(),
                transactionCount: toCreate.length,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors, message: err.errors.map((e) => e.message).join("; ") });
            return;
        }
        console.error("[Bank Recon Upload]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/bank-recon/entries?uploadId= — get GL entries + bank entries for reconciliation
router.get("/entries", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { uploadId } = req.query as { uploadId?: string };
        if (!uploadId) {
            res.status(400).json({ success: false, message: "uploadId required" });
            return;
        }

        const upload = await prisma.bankStatementUpload.findFirst({
            where: { id: uploadId, tenantId },
            include: { entries: true },
        });
        if (!upload) {
            res.status(404).json({ success: false, message: "Upload not found" });
            return;
        }

        const bankEntries = upload.entries.map((e) => ({
            id: e.id,
            source: "BANK",
            date: e.entryDate.toISOString(),
            narration: e.narration,
            amount: Number(e.amount),
            type: e.type as "CR" | "DR",
            matchedGlEntryId: e.matchedGlEntryId,
            status: e.matchedGlEntryId ? "MATCHED" : "UNMATCHED",
            confidence: e.isManualMatch ? 100 : null,
        }));

        const glEntries = await prisma.glEntry.findMany({
            where: {
                tenantId,
                postingDate: { gte: upload.periodStart, lte: upload.periodEnd },
                glCode: { startsWith: "1" },
            },
            orderBy: { postingDate: "asc" },
        });

        const matchedGlIds = new Set(upload.entries.map((e) => e.matchedGlEntryId).filter(Boolean));
        const glRows = glEntries.map((e) => {
            const net = Number(e.debit) - Number(e.credit);
            return {
                id: e.id,
                source: "GL",
                date: e.postingDate.toISOString(),
                narration: e.narration,
                amount: Math.abs(net),
                type: net >= 0 ? ("DR" as const) : ("CR" as const),
                matchedId: null,
                status: matchedGlIds.has(e.id) ? "MATCHED" : "UNMATCHED",
                confidence: matchedGlIds.has(e.id) ? 100 : null,
            };
        });

        const allEntries = [...bankEntries, ...glRows].sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );

        res.json({
            success: true,
            upload: {
                id: upload.id,
                fileName: upload.fileName,
                periodStart: upload.periodStart.toISOString(),
                periodEnd: upload.periodEnd.toISOString(),
            },
            entries: allEntries,
            glEntries: glRows,
            bankEntries,
        });
    } catch (err) {
        console.error("[Bank Recon Entries]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/bank-recon/match — manual match
router.post("/match", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const data = z
            .object({
                bankEntryId: z.string(),
                glEntryId: z.string(),
            })
            .parse(req.body);

        const bankEntry = await prisma.bankStatementEntry.findFirst({
            where: { id: data.bankEntryId, tenantId },
        });
        const glEntry = await prisma.glEntry.findFirst({
            where: { id: data.glEntryId, tenantId },
        });
        if (!bankEntry || !glEntry) {
            res.status(404).json({ success: false, message: "Entry not found" });
            return;
        }

        await prisma.bankStatementEntry.update({
            where: { id: bankEntry.id },
            data: {
                matchedGlEntryId: glEntry.id,
                matchedAt: new Date(),
                isManualMatch: true,
            },
        });

        res.json({ success: true, message: "Matched successfully" });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        console.error("[Bank Recon Match]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/bank-recon/run — auto-match by amount + date
router.post("/run", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { uploadId } = req.body as { uploadId?: string };
        if (!uploadId) {
            res.status(400).json({ success: false, message: "uploadId required" });
            return;
        }

        const upload = await prisma.bankStatementUpload.findFirst({
            where: { id: uploadId, tenantId },
            include: { entries: true },
        });
        if (!upload) {
            res.status(404).json({ success: false, message: "Upload not found" });
            return;
        }

        const glEntries = await prisma.glEntry.findMany({
            where: {
                tenantId,
                postingDate: { gte: upload.periodStart, lte: upload.periodEnd },
                glCode: { startsWith: "1" },
            },
        });

        const unmatchedBank = upload.entries.filter((e) => !e.matchedGlEntryId);
        const unmatchedGl = glEntries.filter((e) => !upload.entries.some((b) => b.matchedGlEntryId === e.id));
        let matched = 0;

        for (const bank of unmatchedBank) {
            const bankAmt = Number(bank.amount);
            const bankDate = new Date(bank.entryDate).getTime();
            const best = unmatchedGl.find((gl) => {
                const glNet = Number(gl.debit) - Number(gl.credit);
                const glAmt = Math.abs(glNet);
                const glDate = new Date(gl.postingDate).getTime();
                const dateDiff = Math.abs(bankDate - glDate) / (24 * 60 * 60 * 1000);
                return Math.abs(bankAmt - glAmt) < 0.01 && dateDiff <= 3;
            });
            if (best) {
                await prisma.bankStatementEntry.update({
                    where: { id: bank.id },
                    data: {
                        matchedGlEntryId: best.id,
                        matchedAt: new Date(),
                        isManualMatch: false,
                    },
                });
                matched++;
                unmatchedGl.splice(unmatchedGl.indexOf(best), 1);
            }
        }

        res.json({
            success: true,
            message: `Auto-matched ${matched} entries`,
            matched,
        });
    } catch (err) {
        console.error("[Bank Recon Run]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/bank-recon/uploads — list uploads
router.get("/uploads", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const uploads = await prisma.bankStatementUpload.findMany({
            where: { tenantId },
            orderBy: { createdAt: "desc" },
            include: { _count: { select: { entries: true } } },
        });
        res.json({
            success: true,
            uploads: uploads.map((u) => ({
                id: u.id,
                fileName: u.fileName,
                bankName: u.bankName,
                periodStart: u.periodStart.toISOString(),
                periodEnd: u.periodEnd.toISOString(),
                transactionCount: u._count.entries,
                createdAt: u.createdAt.toISOString(),
            })),
        });
    } catch (err) {
        console.error("[Bank Recon Uploads]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
