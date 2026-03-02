"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * User management (tenant-scoped for admin/staff)
 * + Audit Log viewer (tenant-scoped)
 */
const express_1 = require("express");
const bcrypt_1 = require("bcrypt");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ─── Users ───────────────────────────────────────────────
// GET /api/v1/users — list users for this tenant
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const users = await prisma_1.default.user.findMany({
            where: { tenantId },
            select: { id: true, email: true, name: true, role: true, status: true, createdAt: true, updatedAt: true },
            orderBy: { createdAt: "desc" },
        });
        res.json({ success: true, users });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PATCH /api/v1/users/:id — update role
router.patch("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;
        const { role } = req.body;
        if (!role) {
            res.status(400).json({ success: false, message: "role required" });
            return;
        }
        const allowed = ["admin", "staff", "superadmin"];
        if (!allowed.includes(role)) {
            res.status(400).json({ success: false, message: "Invalid role" });
            return;
        }
        const user = await prisma_1.default.user.findFirst({ where: { id, tenantId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        const updated = await prisma_1.default.user.update({ where: { id }, data: { role } });
        res.json({ success: true, user: updated });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// PATCH /api/v1/users/:id/status — activate / deactivate
router.patch("/:id/status", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;
        const { status } = req.body;
        if (!status || !["active", "inactive"].includes(status)) {
            res.status(400).json({ success: false, message: "status must be 'active' or 'inactive'" });
            return;
        }
        const user = await prisma_1.default.user.findFirst({ where: { id, tenantId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        const updated = await prisma_1.default.user.update({ where: { id }, data: { status } });
        res.json({ success: true, user: updated });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/users/:id/reset-password — admin resets another user's password
router.post("/:id/reset-password", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { id } = req.params;
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 8) {
            res.status(400).json({ success: false, message: "newPassword must be at least 8 characters" });
            return;
        }
        const user = await prisma_1.default.user.findFirst({ where: { id, tenantId } });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        const passwordHash = await (0, bcrypt_1.hash)(newPassword, 10);
        await prisma_1.default.user.update({ where: { id }, data: { passwordHash } });
        res.json({ success: true, message: "Password reset successfully" });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// ─── Audit Log ───────────────────────────────────────────
// GET /api/v1/users/audit-log — paginated audit trail for this tenant
router.get("/audit-log", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { search, userFilter, dateFrom, dateTo, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        // Build the where clause using individual conditions to keep types clean
        const createdAtFilter = (dateFrom || dateTo) ? {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
        } : undefined;
        const [logs, total] = await Promise.all([
            prisma_1.default.auditLog.findMany({
                where: {
                    tenantId,
                    ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
                    ...(userFilter && userFilter !== "all" ? { user: { name: userFilter } } : {}),
                    ...(search ? {
                        OR: [
                            { action: { contains: search.toUpperCase() } },
                            { entity: { contains: search, mode: "insensitive" } },
                            { entityId: { contains: search } },
                        ],
                    } : {}),
                },
                include: { user: { select: { name: true, role: true } } },
                orderBy: { createdAt: "desc" },
                skip,
                take: parseInt(limit),
            }),
            prisma_1.default.auditLog.count({
                where: {
                    tenantId,
                    ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
                    ...(userFilter && userFilter !== "all" ? { user: { name: userFilter } } : {}),
                    ...(search ? {
                        OR: [
                            { action: { contains: search.toUpperCase() } },
                            { entity: { contains: search, mode: "insensitive" } },
                            { entityId: { contains: search } },
                        ],
                    } : {}),
                },
            }),
        ]);
        const formatted = logs.map((l) => ({
            id: l.id,
            ts: l.createdAt,
            user: l.user?.name || "System",
            role: l.user?.role || "SYSTEM",
            action: l.action,
            resource: l.entityId || l.entity,
            detail: l.newData?.remarks || "",
            ip: l.ipAddress || "-",
            userAgent: l.userAgent || "",
            oldData: l.oldData,
            newData: l.newData,
        }));
        res.json({ success: true, logs: formatted, total, page: parseInt(page), limit: parseInt(limit) });
    }
    catch (err) {
        console.error("[Audit Log]", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=users.js.map