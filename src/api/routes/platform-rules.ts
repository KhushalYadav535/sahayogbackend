/**
 * Platform rules - super admin configures global compliance/risk rules.
 * BRD: Platform-scope rules controlled by Sahayog Technologies.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../../db/prisma";
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

const ruleSchema = z.object({
    id: z.string(),
    name: z.string().min(1),
    category: z.enum(["AML", "CREDIT", "COMPLIANCE", "OPERATIONAL"]),
    condition: z.string().min(1),
    action: z.enum(["BLOCK", "FLAG", "NOTIFY", "APPROVE_REQUIRED"]),
    enabled: z.boolean(),
    priority: z.number().min(1).max(5),
    lastTriggered: z.string().optional(),
    triggerCount: z.number().optional(),
    tenantOverridable: z.boolean(),
});

const DEFAULT_RULES: Record<string, unknown>[] = [
    { id: "R001", name: "Cash Threshold AML Alert", category: "AML", condition: "cash_txn_amount > 200000", action: "FLAG", enabled: true, priority: 1, lastTriggered: "Never", triggerCount: 0, tenantOverridable: false },
    { id: "R002", name: "Structuring Detection", category: "AML", condition: "multiple_deposits_7d > 3 AND total_amount > 450000", action: "NOTIFY", enabled: true, priority: 1, lastTriggered: "Never", triggerCount: 0, tenantOverridable: false },
    { id: "R003", name: "Loan Exposure Limit", category: "CREDIT", condition: "member_loan_outstanding > member_share_capital * 5", action: "BLOCK", enabled: true, priority: 2, lastTriggered: "Never", triggerCount: 0, tenantOverridable: true },
    { id: "R004", name: "NPA Auto-Classify", category: "COMPLIANCE", condition: "emi_overdue_days >= 90", action: "FLAG", enabled: true, priority: 1, lastTriggered: "Never", triggerCount: 0, tenantOverridable: false },
    { id: "R005", name: "Dormant Account Block", category: "OPERATIONAL", condition: "account_inactive_months >= 24", action: "BLOCK", enabled: true, priority: 3, lastTriggered: "Never", triggerCount: 0, tenantOverridable: true },
];

async function getRules(): Promise<Record<string, unknown>[]> {
    const cfg = await prisma.platformConfig.findUnique({
        where: { key: "platform.rules" },
    });
    if (!cfg?.value) return DEFAULT_RULES;
    try {
        const parsed = JSON.parse(cfg.value) as Record<string, unknown>[];
        return Array.isArray(parsed) ? parsed : DEFAULT_RULES;
    } catch {
        return DEFAULT_RULES;
    }
}

// GET /api/v1/platform/rules — list platform rules (super admin)
router.get("/", authMiddleware, requireRole("superadmin"), async (_req: Request, res: Response): Promise<void> => {
    try {
        const rules = await getRules();
        res.json({ success: true, rules });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PUT /api/v1/platform/rules — save platform rules (super admin)
router.put("/", authMiddleware, requireRole("superadmin"), async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const body = req.body as { rules: unknown[] };
        const raw = Array.isArray(body.rules) ? body.rules : [];
        const rules = raw.map((r) => {
            const parsed = ruleSchema.safeParse(r);
            if (!parsed.success) throw parsed.error;
            return { ...parsed.data, lastTriggered: parsed.data.lastTriggered || "Never", triggerCount: parsed.data.triggerCount ?? 0 };
        });

        const value = JSON.stringify(rules);
        await prisma.platformConfig.upsert({
            where: { key: "platform.rules" },
            update: { value, label: "Platform compliance & risk rules" },
            create: { key: "platform.rules", value, label: "Platform compliance & risk rules" },
        });
        res.json({ success: true, rules });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
