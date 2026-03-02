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
// Infer type from GL code prefix: 1=ASSET, 2=LIABILITY, 3=EQUITY, 4=INCOME, 5=EXPENSE
function inferTypeFromCode(code) {
    const first = code.charAt(0);
    const map = { "1": "ASSET", "2": "LIABILITY", "3": "EQUITY", "4": "INCOME", "5": "EXPENSE" };
    return map[first] || "ASSET";
}
// GET /api/v1/gl/coa — Chart of Accounts (master + entries from vouchers)
router.get("/coa", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const masterAccounts = await prisma_1.default.glAccount.findMany({
            where: { tenantId, isActive: true },
            orderBy: { code: "asc" },
        });
        const entries = await prisma_1.default.glEntry.groupBy({
            by: ["glCode", "glName"],
            where: { tenantId },
            _sum: { debit: true, credit: true },
        });
        const balanceByCode = {};
        const masterByCode = new Map(masterAccounts.map((a) => [a.code, a]));
        entries.forEach((e) => {
            balanceByCode[e.glCode] = {
                debit: Number(e._sum.debit ?? 0),
                credit: Number(e._sum.credit ?? 0),
            };
        });
        const seen = new Set();
        const rows = [];
        for (const a of masterAccounts) {
            seen.add(a.code);
            const bal = balanceByCode[a.code] || { debit: 0, credit: 0 };
            const net = ["ASSET", "EXPENSE"].includes(a.type) ? bal.debit - bal.credit : bal.credit - bal.debit;
            rows.push({ id: a.id, code: a.code, name: a.name, type: a.type, parent: a.parentCode, balance: net, openingBalance: 0, isActive: a.isActive });
        }
        for (const e of entries) {
            if (seen.has(e.glCode))
                continue;
            seen.add(e.glCode);
            const bal = balanceByCode[e.glCode] || { debit: 0, credit: 0 };
            const type = inferTypeFromCode(e.glCode);
            const net = ["ASSET", "EXPENSE"].includes(type) ? bal.debit - bal.credit : bal.credit - bal.debit;
            rows.push({ code: e.glCode, name: e.glName, type, parent: undefined, balance: net, openingBalance: 0, isActive: true });
        }
        rows.sort((a, b) => a.code.localeCompare(b.code));
        res.json({ success: true, accounts: rows });
    }
    catch (err) {
        console.error("[GL COA GET]", err);
        const msg = err instanceof Error ? err.message : "Server error";
        res.status(500).json({ success: false, message: msg });
    }
});
// POST /api/v1/gl/coa — Add Account
router.post("/coa", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            code: zod_1.z.string().min(1).max(20),
            name: zod_1.z.string().min(1).max(200),
            type: zod_1.z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]),
            parentCode: zod_1.z.string().optional(),
        }).parse(req.body);
        const existing = await prisma_1.default.glAccount.findFirst({
            where: { tenantId, code: data.code },
        });
        if (existing) {
            res.status(409).json({ success: false, message: `Account code ${data.code} already exists` });
            return;
        }
        const account = await prisma_1.default.glAccount.create({
            data: {
                tenantId,
                code: data.code,
                name: data.name,
                type: data.type,
                parentCode: data.parentCode || null,
            },
        });
        res.status(201).json({
            success: true,
            account: {
                id: account.id,
                code: account.code,
                name: account.name,
                type: account.type,
                parent: account.parentCode,
                balance: 0,
                openingBalance: 0,
                isActive: account.isActive,
            },
        });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors, message: err.errors.map((e) => e.message).join("; ") });
            return;
        }
        console.error("[GL COA POST]", err);
        const msg = err instanceof Error ? err.message : "Server error";
        res.status(500).json({ success: false, message: msg });
    }
});
// POST /api/v1/gl/vouchers — Create voucher (maker)
router.post("/vouchers", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            voucherType: zod_1.z.enum(["JV", "RV", "PV", "BV"]),
            date: zod_1.z.string(),
            narration: zod_1.z.string().optional(),
            totalAmount: zod_1.z.number().positive(),
            entries: zod_1.z.array(zod_1.z.object({
                glCode: zod_1.z.string().min(1),
                glName: zod_1.z.string().default(""),
                debit: zod_1.z.number().default(0),
                credit: zod_1.z.number().default(0),
                narration: zod_1.z.string().optional(),
            })).min(2),
        }).parse(req.body);
        const count = await prisma_1.default.voucher.count({ where: { tenantId } });
        const voucherNumber = `${data.voucherType}${String(count + 1).padStart(6, "0")}`;
        // Tenant admin (role=admin) can post directly without maker-checker approval
        const isTenantAdmin = req.user?.role === "admin";
        const initialStatus = isTenantAdmin ? "posted" : "pending";
        const voucher = await prisma_1.default.$transaction(async (tx) => {
            const v = await tx.voucher.create({
                data: {
                    tenantId,
                    voucherNumber,
                    voucherType: data.voucherType,
                    date: new Date(data.date),
                    narration: data.narration,
                    totalAmount: data.totalAmount,
                    status: initialStatus,
                    makerUserId: req.user?.userId,
                    ...(isTenantAdmin && {
                        checkerUserId: req.user?.userId,
                        approvedAt: new Date(),
                    }),
                },
            });
            const period = data.date.substring(0, 7); // YYYY-MM
            await tx.glEntry.createMany({
                data: data.entries.map((e) => ({
                    tenantId,
                    voucherId: v.id,
                    glCode: e.glCode,
                    glName: e.glName,
                    debit: e.debit,
                    credit: e.credit,
                    narration: e.narration,
                    postingDate: new Date(data.date),
                    period,
                })),
            });
            return v;
        });
        res.status(201).json({ success: true, voucher });
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, errors: err.errors });
            return;
        }
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/gl/vouchers
router.get("/vouchers", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { voucherType, status, page = "1", limit = "20" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const where = { tenantId };
        if (voucherType)
            where.voucherType = voucherType;
        if (status)
            where.status = status;
        const [vouchers, total] = await Promise.all([
            prisma_1.default.voucher.findMany({
                where,
                skip,
                take: parseInt(limit),
                orderBy: { date: "desc" },
                include: { glEntries: true },
            }),
            prisma_1.default.voucher.count({ where }),
        ]);
        res.json({ success: true, vouchers, total });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/gl/vouchers/:id/approve  (checker)
router.post("/vouchers/:id/approve", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const voucher = await prisma_1.default.voucher.update({
            where: { id: req.params.id },
            data: { status: "approved", checkerUserId: req.user?.userId, approvedAt: new Date() },
        });
        res.json({ success: true, voucher });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/gl/vouchers/:id/post
router.post("/vouchers/:id/post", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const voucher = await prisma_1.default.voucher.update({
            where: { id: req.params.id },
            data: { status: "posted" },
        });
        res.json({ success: true, voucher });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// POST /api/v1/gl/vouchers/:id/reverse
router.post("/vouchers/:id/reverse", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const original = await prisma_1.default.voucher.findUnique({ where: { id: req.params.id }, include: { glEntries: true } });
        if (!original) {
            res.status(404).json({ success: false, message: "Voucher not found" });
            return;
        }
        const count = await prisma_1.default.voucher.count({ where: { tenantId } });
        const voucherNumber = `RV${String(count + 1).padStart(6, "0")}`;
        const reversal = await prisma_1.default.$transaction(async (tx) => {
            const v = await tx.voucher.create({
                data: {
                    tenantId,
                    voucherNumber,
                    voucherType: "RV",
                    date: new Date(),
                    narration: `Reversal of ${original.voucherNumber}`,
                    totalAmount: original.totalAmount,
                    status: "posted",
                    makerUserId: req.user?.userId,
                    reversalOf: original.id,
                },
            });
            const period = new Date().toISOString().substring(0, 7);
            await tx.glEntry.createMany({
                data: original.glEntries.map((e) => ({
                    tenantId,
                    voucherId: v.id,
                    glCode: e.glCode,
                    glName: e.glName,
                    debit: e.credit, // swap debit/credit for reversal
                    credit: e.debit,
                    narration: `Reversal: ${e.narration || ""}`,
                    postingDate: new Date(),
                    period,
                })),
            });
            await tx.voucher.update({ where: { id: original.id }, data: { status: "reversed" } });
            return v;
        });
        res.status(201).json({ success: true, reversal });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// Build date filter: prefers fromDate/toDate (exact range), else period (YYYY-MM)
function buildGlWhere(tenantId, period, fromDate, toDate) {
    const where = { tenantId };
    if (fromDate || toDate) {
        const dateFilter = {};
        if (fromDate)
            dateFilter.gte = new Date(fromDate);
        if (toDate) {
            const end = new Date(toDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }
        if (Object.keys(dateFilter).length)
            where.postingDate = dateFilter;
    }
    else if (period) {
        where.period = period;
    }
    return where;
}
// GET /api/v1/gl/trial-balance
router.get("/trial-balance", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { period, fromDate, toDate } = req.query;
        const where = buildGlWhere(tenantId, period, fromDate, toDate);
        const entries = await prisma_1.default.glEntry.groupBy({
            by: ["glCode", "glName"],
            where,
            _sum: { debit: true, credit: true },
        });
        const rows = entries.map((e) => ({
            glCode: e.glCode,
            glName: e.glName,
            totalDebit: Number(e._sum.debit ?? 0),
            totalCredit: Number(e._sum.credit ?? 0),
            net: Number(e._sum.debit ?? 0) - Number(e._sum.credit ?? 0),
        }));
        const totals = rows.reduce((acc, r) => ({ totalDebit: acc.totalDebit + r.totalDebit, totalCredit: acc.totalCredit + r.totalCredit }), { totalDebit: 0, totalCredit: 0 });
        res.json({ success: true, rows, totals, period });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/gl/balance-sheet
// asOnDate: entries with postingDate <= asOnDate (cumulative). Or use fromDate/toDate/period.
router.get("/balance-sheet", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { period, fromDate, toDate, asOnDate } = req.query;
        const where = { tenantId };
        if (asOnDate) {
            const end = new Date(asOnDate);
            end.setHours(23, 59, 59, 999);
            where.postingDate = { lte: end };
        }
        else {
            Object.assign(where, buildGlWhere(tenantId, period, fromDate, toDate));
        }
        const entries = await prisma_1.default.glEntry.groupBy({
            by: ["glCode", "glName"],
            where,
            _sum: { debit: true, credit: true },
        });
        const assets = entries.filter((e) => e.glCode.startsWith("1")).map((e) => ({
            glCode: e.glCode,
            glName: e.glName,
            amount: Number(e._sum.debit ?? 0) - Number(e._sum.credit ?? 0),
        }));
        const liabilities = entries.filter((e) => e.glCode.startsWith("2")).map((e) => ({
            glCode: e.glCode,
            glName: e.glName,
            amount: Number(e._sum.credit ?? 0) - Number(e._sum.debit ?? 0),
        }));
        const equity = entries.filter((e) => e.glCode.startsWith("3")).map((e) => ({
            glCode: e.glCode,
            glName: e.glName,
            amount: Number(e._sum.credit ?? 0) - Number(e._sum.debit ?? 0),
        }));
        res.json({
            success: true,
            assets,
            liabilities,
            equity,
            totalAssets: assets.reduce((s, e) => s + e.amount, 0),
            totalLiabilitiesEquity: liabilities.reduce((s, e) => s + e.amount, 0) + equity.reduce((s, e) => s + e.amount, 0),
            period,
        });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
// GET /api/v1/gl/pl
router.get("/pl", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { period, fromDate, toDate } = req.query;
        const where = buildGlWhere(tenantId, period, fromDate, toDate);
        const entries = await prisma_1.default.glEntry.groupBy({
            by: ["glCode", "glName"],
            where,
            _sum: { debit: true, credit: true },
        });
        const income = entries.filter((e) => e.glCode.startsWith("4")).map((e) => ({
            glCode: e.glCode,
            glName: e.glName,
            amount: Number(e._sum.credit ?? 0) - Number(e._sum.debit ?? 0),
        }));
        const expenses = entries.filter((e) => e.glCode.startsWith("5")).map((e) => ({
            glCode: e.glCode,
            glName: e.glName,
            amount: Number(e._sum.debit ?? 0) - Number(e._sum.credit ?? 0),
        }));
        const totalIncome = income.reduce((s, e) => s + e.amount, 0);
        const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
        res.json({ success: true, income, expenses, totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses, period });
    }
    catch {
        res.status(500).json({ success: false, message: "Server error" });
    }
});
exports.default = router;
//# sourceMappingURL=gl.js.map