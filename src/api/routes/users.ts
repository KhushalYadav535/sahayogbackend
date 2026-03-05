/**
 * User management (tenant-scoped for admin/staff)
 * + Audit Log viewer (tenant-scoped)
 */
import { Router, Response } from "express";
import { hash } from "bcrypt";
import prisma from "../../db/prisma";
import { authMiddleware, requireTenant, AuthRequest } from "../middleware/auth";

const router = Router();

// ─── Users ───────────────────────────────────────────────

// GET /api/v1/users — list users for this tenant
router.get("/", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const users = await prisma.user.findMany({
            where: { tenantId },
            select: { id: true, email: true, name: true, role: true, status: true, createdAt: true, updatedAt: true },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, users });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PATCH /api/v1/users/:id — update role
router.patch("/:id", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { id } = req.params;
        const { role } = req.body as { role?: string };
        if (!role) { res.status(400).json({ success: false, message: "role required" }); return; }
        const allowed = [
            "superadmin", "admin", "president", "secretary",
            "accountant", "senior_accountant", "loan_officer",
            "compliance_officer", "auditor", "member", "staff",
        ];
        if (!allowed.includes(role)) { res.status(400).json({ success: false, message: "Invalid role" }); return; }

        const user = await prisma.user.findFirst({ where: { id, tenantId } });
        if (!user) { res.status(404).json({ success: false, message: "User not found" }); return; }

        const updated = await prisma.user.update({ where: { id }, data: { role } });
        res.json({ success: true, user: updated });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// PATCH /api/v1/users/:id/status — activate / deactivate
router.patch("/:id/status", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { id } = req.params;
        const { status } = req.body as { status?: string };
        if (!status || !["active", "inactive"].includes(status)) {
            res.status(400).json({ success: false, message: "status must be 'active' or 'inactive'" });
            return;
        }
        const user = await prisma.user.findFirst({ where: { id, tenantId } });
        if (!user) { res.status(404).json({ success: false, message: "User not found" }); return; }

        const updated = await prisma.user.update({ where: { id }, data: { status } });
        res.json({ success: true, user: updated });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/users/:id/reset-password — admin resets another user's password
router.post("/:id/reset-password", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { id } = req.params;
        const { newPassword } = req.body as { newPassword?: string };
        if (!newPassword || newPassword.length < 8) {
            res.status(400).json({ success: false, message: "newPassword must be at least 8 characters" });
            return;
        }
        const user = await prisma.user.findFirst({ where: { id, tenantId } });
        if (!user) { res.status(404).json({ success: false, message: "User not found" }); return; }

        const passwordHash = await hash(newPassword, 10);
        await prisma.user.update({ where: { id }, data: { passwordHash } });
        res.json({ success: true, message: "Password reset successfully" });
    } catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ─── Audit Log ───────────────────────────────────────────

// GET /api/v1/users/audit-log — paginated audit trail for this tenant
router.get("/audit-log", authMiddleware, requireTenant, async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const tenantId = req.user!.tenantId!;
        const { search, userFilter, dateFrom, dateTo, page = "1", limit = "20" } = req.query as Record<string, string>;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Build the where clause using individual conditions to keep types clean
        const createdAtFilter = (dateFrom || dateTo) ? {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
        } : undefined;

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where: {
                    tenantId,
                    ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
                    ...(userFilter && userFilter !== "all" ? { user: { name: userFilter } } : {}),
                    ...(search ? {
                        OR: [
                            { action: { contains: search.toUpperCase() } },
                            { entity: { contains: search, mode: "insensitive" as const } },
                            { entityId: { contains: search } },
                        ],
                    } : {}),
                },
                include: { user: { select: { name: true, role: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take: parseInt(limit),
            }),
            prisma.auditLog.count({
                where: {
                    tenantId,
                    ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
                    ...(userFilter && userFilter !== "all" ? { user: { name: userFilter } } : {}),
                    ...(search ? {
                        OR: [
                            { action: { contains: search.toUpperCase() } },
                            { entity: { contains: search, mode: "insensitive" as const } },
                            { entityId: { contains: search } },
                        ],
                    } : {}),
                },
            }),
        ]);

        type LogRow = Awaited<ReturnType<typeof prisma.auditLog.findMany>>[number] & { user: { name: string; role: string } | null };
        const formatted = (logs as LogRow[]).map((l) => ({
            id: l.id,
            ts: l.createdAt,
            user: l.user?.name || "System",
            role: l.user?.role || "SYSTEM",
            action: l.action,
            resource: l.entityId || l.entity,
            detail: ((l.newData as Record<string, unknown>)?.remarks as string) || "",
            ip: l.ipAddress || "-",
            userAgent: l.userAgent || "",
            oldData: l.oldData,
            newData: l.newData,
        }));

        res.json({ success: true, logs: formatted, total, page: parseInt(page), limit: parseInt(limit) });
    } catch (err) {
        console.error("[Audit Log]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

export default router;
