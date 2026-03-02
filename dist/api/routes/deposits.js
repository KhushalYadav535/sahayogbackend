"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// POST /api/v1/deposits — Create FDR/RD/MIS
router.post("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const schema = zod_1.z.object({
            memberId: zod_1.z.string(),
            depositType: zod_1.z.enum(["fd", "rd", "mis"]),
            principal: zod_1.z.number().positive(),
            interestRate: zod_1.z.number().min(0).max(20),
            tenureMonths: zod_1.z.number().int().positive(),
            compoundingFreq: zod_1.z.enum(["monthly", "quarterly", "half_yearly", "yearly"]).default("quarterly"),
            rdMonthlyAmount: zod_1.z.number().positive().optional(),
            form15Exempt: zod_1.z.boolean().optional(),
        });
        const data = schema.parse(req.body);
        // Validate member exists and is active
        const member = await prisma_1.default.member.findFirst({
            where: { id: data.memberId, tenantId },
        });
        if (!member) {
            res.status(404).json({ success: false, message: "Member not found" });
            return;
        }
        if (member.status !== "active") {
            res.status(400).json({ success: false, message: "Member must be active to open deposit" });
            return;
        }
        const count = await prisma_1.default.deposit.count({ where: { tenantId } });
        const prefix = data.depositType.toUpperCase().slice(0, 2);
        const depositNumber = `${prefix}${String(count + 1).padStart(8, "0")}`;
        const openedAt = new Date();
        const maturityDate = new Date(openedAt);
        maturityDate.setMonth(maturityDate.getMonth() + data.tenureMonths);
        const n = data.compoundingFreq === "monthly" ? 12 : data.compoundingFreq === "quarterly" ? 4 : data.compoundingFreq === "half_yearly" ? 2 : 1;
        const principal = Number(data.principal);
        const rate = data.interestRate / 100;
        const months = data.tenureMonths;
        const maturityAmount = principal * Math.pow(1 + rate / n, (n * months) / 12);
        const deposit = await prisma_1.default.deposit.create({
            data: {
                tenantId,
                memberId: data.memberId,
                depositNumber,
                depositType: data.depositType,
                principal: data.principal,
                interestRate: data.interestRate,
                tenureMonths: data.tenureMonths,
                compoundingFreq: data.compoundingFreq,
                maturityDate,
                maturityAmount: Math.round(maturityAmount * 100) / 100,
                rdMonthlyAmount: data.rdMonthlyAmount ?? null,
                status: "active",
            },
            include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
        });
        res.status(201).json({ success: true, deposit });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/deposits
router.get("/", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { memberId, status, depositType, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (memberId)
            where.memberId = memberId;
        if (status)
            where.status = status;
        if (depositType)
            where.depositType = depositType;
        const [deposits, total] = await Promise.all([
            prisma_1.default.deposit.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { openedAt: "desc" },
                include: { member: { select: { firstName: true, lastName: true, memberNumber: true } } },
            }),
            prisma_1.default.deposit.count({ where }),
        ]);
        res.json({ success: true, deposits, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/deposits/:id
router.get("/:id", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const deposit = await prisma_1.default.deposit.findFirst({
            where: { id: req.params.id, tenantId },
            include: {
                member: { select: { firstName: true, lastName: true, memberNumber: true, phone: true } },
            },
        });
        if (!deposit) {
            res.status(404).json({ success: false, message: "Deposit not found" });
            return;
        }
        res.json({ success: true, deposit });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=deposits.js.map