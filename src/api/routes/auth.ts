import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import prisma from "../../db/prisma";
import { createAuditLog } from "../../db/audit";

const router = Router();

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
});

// POST /api/v1/auth/login
router.post("/login", async (req: Request, res: Response): Promise<void> => {
    try {
        const body = req.body || {};
        const { email, password } = loginSchema.parse(body);

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            res.status(401).json({ success: false, message: "Invalid credentials" });
            return;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            res.status(401).json({ success: false, message: "Invalid credentials" });
            return;
        }

        if (user.status !== "active") {
            res.status(403).json({ success: false, message: "Account is not active" });
            return;
        }

        const token = jwt.sign(
            {
                userId: user.id,
                tenantId: user.tenantId,
                role: user.role,
                email: user.email,
            },
            process.env.JWT_SECRET || "fallback_secret",
            { expiresIn: "8h" }
        );

        createAuditLog({
            tenantId: user.tenantId ?? undefined,
            userId: user.id,
            action: "LOGIN",
            entity: "User",
            entityId: user.id,
            ipAddress: req.ip,
        }).catch((e) => console.error("[Auth] Audit log failed:", e));

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                tenantId: user.tenantId,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        console.error("[Auth] Login error:", err);
        const msg = err instanceof Error ? err.message : "Server error";
        res.status(500).json({ success: false, message: process.env.NODE_ENV === "development" ? msg : "Server error" });
    }
});

// POST /api/v1/auth/register (superadmin or admin creating users)
router.post("/register", async (req: Request, res: Response): Promise<void> => {
    try {
        const schema = z.object({
            email: z.string().email(),
            password: z.string().min(8),
            name: z.string().min(2),
            role: z.enum(["superadmin", "admin", "staff"]).default("staff"),
            tenantId: z.string().optional(),
        });

        const data = schema.parse(req.body);
        const passwordHash = await bcrypt.hash(data.password, 12);

        const user = await prisma.user.create({
            data: {
                email: data.email,
                passwordHash,
                name: data.name,
                role: data.role,
                tenantId: data.tenantId,
            },
        });

        res.status(201).json({
            success: true,
            user: { id: user.id, email: user.email, name: user.name, role: user.role },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/auth/register-tenant (Public Self-Serve Registration)
router.post("/register-tenant", async (req: Request, res: Response): Promise<void> => {
    try {
        const schema = z.object({
            societyName: z.string().min(2),
            adminName: z.string().min(2),
            email: z.string().email(),
            password: z.string().min(8)
        });

        const data = schema.parse(req.body);

        // Check if user already exists
        const existingUser = await prisma.user.findUnique({ where: { email: data.email } });
        if (existingUser) {
            res.status(400).json({ success: false, message: "User with this email already exists" });
            return;
        }

        // Generate a 4-letter + 4-digit code
        const safeName = data.societyName.replace(/[^A-Za-z]/g, "");
        const prefix = safeName.length >= 4 ? safeName.substring(0, 4).toUpperCase() : (safeName.toUpperCase() + "SOC1").substring(0, 4);
        const code = prefix + Math.floor(1000 + Math.random() * 9000);

        // Create the new Tenant
        const tenant = await prisma.tenant.create({
            data: {
                name: data.societyName,
                code: code,
                plan: "starter",
                status: "active"
            }
        });

        const passwordHash = await bcrypt.hash(data.password, 12);

        // Create the Admin User
        const user = await prisma.user.create({
            data: {
                email: data.email,
                name: data.adminName,
                passwordHash,
                role: "admin",
                tenantId: tenant.id,
                status: "active"
            }
        });

        res.status(201).json({
            success: true,
            tenant: { id: tenant.id, name: tenant.name, code: tenant.code },
            user: { id: user.id, email: user.email, name: user.name, role: user.role }
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.issues });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/v1/auth/impersonate — super admin impersonates tenant admin
router.post("/impersonate", async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "No token provided" });
        return;
    }
    try {
        const callerPayload = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET || "fallback_secret") as { userId: string; role: string };
        if (callerPayload.role !== "superadmin") {
            res.status(403).json({ success: false, message: "Only super admin can impersonate" });
            return;
        }
        const { tenantId } = z.object({ tenantId: z.string() }).parse(req.body);
        const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
        if (!tenant) {
            res.status(404).json({ success: false, message: "Tenant not found" });
            return;
        }
        const adminUser = await prisma.user.findFirst({
            where: { tenantId, role: "admin", status: "active" },
        });
        if (!adminUser) {
            res.status(404).json({ success: false, message: "No active admin user found for this tenant" });
            return;
        }
        const token = jwt.sign(
            {
                userId: adminUser.id,
                tenantId: adminUser.tenantId,
                role: adminUser.role,
                email: adminUser.email,
                impersonatedBy: callerPayload.userId,
            },
            process.env.JWT_SECRET || "fallback_secret",
            { expiresIn: "2h" }
        );
        res.json({
            success: true,
            token,
            user: { id: adminUser.id, email: adminUser.email, name: adminUser.name, role: adminUser.role, tenantId: adminUser.tenantId },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/v1/auth/me
router.get("/me", async (req: Request, res: Response): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
    }
    try {
        const token = authHeader.split(" ")[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret") as { userId: string };
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: { id: true, email: true, name: true, role: true, tenantId: true, status: true },
        });
        if (!user) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }
        res.json({ success: true, user });
    } catch {
        res.status(401).json({ success: false, message: "Invalid token" });
    }
});

export default router;
