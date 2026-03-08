"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const gl_posting_1 = require("../../lib/gl-posting");
const multer_1 = __importDefault(require("multer"));
const XLSX = __importStar(require("xlsx"));
const router = (0, express_1.Router)();
// Configure multer for file uploads (memory storage)
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (_req, file, cb) => {
        const allowedMimes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
            'application/vnd.ms-excel', // .xls
            'application/vnd.ms-excel.sheet.macroEnabled.12', // .xlsm
        ];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new Error('Invalid file type. Only Excel files (.xlsx, .xls) are allowed.'));
        }
    },
});
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
// AI-005: Auto-Ledger Classification Helper
async function suggestGlCode(narration, tenantId) {
    const narrationLower = narration.toLowerCase();
    // Simple keyword-based classification (can be enhanced with NLP)
    const patterns = [
        { keywords: ["salary", "wages", "staff"], glCode: "12-02-0001", glName: "Salaries & Wages" },
        { keywords: ["interest", "fd", "deposit"], glCode: "12-01-0002", glName: "Interest on FDs" },
        { keywords: ["rent", "premises"], glCode: "12-03-0001", glName: "Rent Expenses" },
        { keywords: ["electricity", "power", "utility"], glCode: "12-03-0002", glName: "Electricity Expenses" },
        { keywords: ["stationery", "office"], glCode: "12-03-0003", glName: "Office Expenses" },
        { keywords: ["audit", "professional"], glCode: "12-03-0004", glName: "Professional Fees" },
        { keywords: ["loan", "advance"], glCode: "02-03-0001", glName: "Loans & Advances" },
        { keywords: ["cash", "petty"], glCode: "05-01-0001", glName: "Cash in Hand" },
    ];
    for (const pattern of patterns) {
        if (pattern.keywords.some(kw => narrationLower.includes(kw))) {
            return { glCode: pattern.glCode, glName: pattern.glName, confidence: 0.85 };
        }
    }
    return null;
}
// POST /api/v1/gl/vouchers — Create voucher (maker)
router.post("/vouchers", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = zod_1.z.object({
            voucherType: zod_1.z.enum(["JV", "RV", "PV", "BV", "AUDIT_ADJ"]),
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
            // ACC-010: Audit Adjustment Entries
            isAuditAdjustment: zod_1.z.boolean().optional(),
            auditAccessStartDate: zod_1.z.string().optional(),
            auditAccessEndDate: zod_1.z.string().optional(),
        }).parse(req.body);
        // ACC-010: Check if period is closed (block non-audit entries)
        const voucherPeriod = data.date.substring(0, 7); // YYYY-MM
        const tenant = await prisma_1.default.tenant.findUnique({ where: { id: tenantId } });
        const isPeriodClosed = tenant?.closedPeriods?.includes(voucherPeriod) || false;
        const isAuditAdj = data.voucherType === "AUDIT_ADJ" || data.isAuditAdjustment;
        if (isPeriodClosed && !isAuditAdj) {
            res.status(403).json({
                success: false,
                message: `Period ${voucherPeriod} is closed. Only audit adjustment entries are allowed.`,
            });
            return;
        }
        // ACC-010: Validate audit access period
        if (isAuditAdj && req.user?.role !== "auditor" && req.user?.role !== "admin") {
            res.status(403).json({
                success: false,
                message: "Only auditors and admins can create audit adjustment entries",
            });
            return;
        }
        if (isAuditAdj && data.auditAccessStartDate && data.auditAccessEndDate) {
            const now = new Date();
            const accessStart = new Date(data.auditAccessStartDate);
            const accessEnd = new Date(data.auditAccessEndDate);
            if (now < accessStart || now > accessEnd) {
                res.status(403).json({
                    success: false,
                    message: "Audit access period has expired or not yet started",
                });
                return;
            }
        }
        // DA-001: Generate voucher number - VCH-YYYY-MM-NNNNNN format
        const count = await prisma_1.default.voucher.count({ where: { tenantId } });
        const { generateVoucherId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
        const voucherDate = new Date(data.date);
        const voucherNumber = isAuditAdj
            ? `AUDIT-${voucherDate.getFullYear()}-${String(voucherDate.getMonth() + 1).padStart(2, "0")}-${String(count + 1).padStart(6, "0")}`
            : generateVoucherId(count + 1, voucherDate.getFullYear(), voucherDate.getMonth() + 1);
        // Tenant admin (role=admin) can post directly without maker-checker approval
        // Audit adjustments always require maker-checker
        const isTenantAdmin = req.user?.role === "admin" && !isAuditAdj;
        const initialStatus = isTenantAdmin ? "posted" : "pending";
        const voucher = await prisma_1.default.$transaction(async (tx) => {
            const v = await tx.voucher.create({
                data: {
                    tenantId,
                    voucherNumber,
                    voucherType: isAuditAdj ? "AUDIT_ADJ" : data.voucherType,
                    date: new Date(data.date),
                    narration: data.narration,
                    totalAmount: data.totalAmount,
                    status: initialStatus,
                    makerUserId: req.user?.userId,
                    isAuditAdjustment: isAuditAdj,
                    auditAccessStartDate: isAuditAdj && data.auditAccessStartDate ? new Date(data.auditAccessStartDate) : null,
                    auditAccessEndDate: isAuditAdj && data.auditAccessEndDate ? new Date(data.auditAccessEndDate) : null,
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
// AI-005: POST /api/v1/gl/suggest-classification — Auto-Ledger Classification
router.post("/suggest-classification", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { narration } = zod_1.z.object({
            narration: zod_1.z.string().min(1),
        }).parse(req.body);
        const suggestion = await suggestGlCode(narration, tenantId);
        if (!suggestion) {
            res.json({ success: true, suggestion: null });
            return;
        }
        // Log classification attempt
        await prisma_1.default.aiAuditLog.create({
            data: {
                tenantId,
                userId: req.user?.userId,
                feature: "auto_ledger_classification",
                inputData: JSON.stringify({ narration }),
                outputData: JSON.stringify(suggestion),
                success: true,
                confidence: suggestion.confidence,
                modelVersion: "v1.0",
            },
        });
        res.json({ success: true, suggestion });
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
        // DA-001: Generate reversal voucher number - VCH-YYYY-MM-NNNNNN format
        const count = await prisma_1.default.voucher.count({ where: { tenantId } });
        const { generateVoucherId } = await Promise.resolve().then(() => __importStar(require("../../lib/id-generator")));
        const now = new Date();
        const voucherNumber = generateVoucherId(count + 1, now.getFullYear(), now.getMonth() + 1).replace("VCH", "RV");
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
        const { period, fromDate, toDate, excludeAuditAdj } = req.query;
        const where = buildGlWhere(tenantId, period, fromDate, toDate);
        // ACC-010: Option to exclude audit adjustments for pre-adjustment TB
        if (excludeAuditAdj === "true") {
            const auditVoucherIds = await prisma_1.default.voucher.findMany({
                where: { tenantId, isAuditAdjustment: true },
                select: { id: true },
            });
            if (auditVoucherIds.length > 0) {
                where.voucherId = { notIn: auditVoucherIds.map((v) => v.id) };
            }
        }
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
        // Check if period is frozen
        const tenant = await prisma_1.default.tenant.findUnique({ where: { id: tenantId } });
        const isFrozen = tenant?.closedPeriods?.includes(period || "") || false;
        res.json({
            success: true,
            rows,
            totals,
            period: period || (fromDate && toDate ? `${fromDate} to ${toDate}` : (0, gl_posting_1.currentPeriod)()),
            isFrozen,
            frozenAt: isFrozen ? new Date().toISOString() : null,
        });
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
// POST /api/v1/gl/coa/upload — Bulk Upload Chart of Accounts from Excel
router.post("/coa/upload", auth_1.authMiddleware, auth_1.requireTenant, upload.single("file"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        if (!req.file) {
            res.status(400).json({ success: false, message: "No file uploaded" });
            return;
        }
        // Parse Excel file
        const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        // Expected Excel format:
        // Row 1: Headers (Code, Name, Type, Parent Code, Schedule, State)
        // Row 2+: Data rows
        if (data.length < 2) {
            res.status(400).json({ success: false, message: "Excel file must contain at least header row and one data row" });
            return;
        }
        const headers = data[0].map((h) => String(h || "").toLowerCase().trim());
        const codeIdx = headers.findIndex((h) => h.includes("code") && !h.includes("parent"));
        const nameIdx = headers.findIndex((h) => h.includes("name") || h.includes("account"));
        const typeIdx = headers.findIndex((h) => h.includes("type"));
        const parentIdx = headers.findIndex((h) => h.includes("parent"));
        const scheduleIdx = headers.findIndex((h) => h.includes("schedule"));
        const stateIdx = headers.findIndex((h) => h.includes("state"));
        if (codeIdx === -1 || nameIdx === -1 || typeIdx === -1) {
            res.status(400).json({
                success: false,
                message: "Excel file must contain columns: Code, Name, Type (and optionally Parent Code, Schedule, State)"
            });
            return;
        }
        // Get tenant state for validation
        const tenant = await prisma_1.default.tenant.findUnique({
            where: { id: tenantId },
            select: { state: true },
        });
        const tenantState = tenant?.state?.toUpperCase() || "";
        // Valid states for NABARD/RBI CoA
        const validStates = ["MP", "UP", "RAJASTHAN", "CHHATTISGARH", "MAHARASHTRA", "MADHYA PRADESH", "UTTAR PRADESH", "CHHATTISGARH"];
        const isStateValid = !tenantState || validStates.some(s => tenantState.includes(s) || s.includes(tenantState));
        const accounts = [];
        const errors = [];
        const validTypes = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
        // Process data rows
        for (let i = 1; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0)
                continue;
            const code = String(row[codeIdx] || "").trim();
            const name = String(row[nameIdx] || "").trim();
            const type = String(row[typeIdx] || "").trim().toUpperCase();
            const parentCode = parentIdx >= 0 ? String(row[parentIdx] || "").trim() : undefined;
            const schedule = scheduleIdx >= 0 ? String(row[scheduleIdx] || "").trim() : undefined;
            const state = stateIdx >= 0 ? String(row[stateIdx] || "").trim().toUpperCase() : undefined;
            // Validation
            if (!code) {
                errors.push({ row: i + 1, error: "Code is required" });
                continue;
            }
            if (!name) {
                errors.push({ row: i + 1, error: "Name is required" });
                continue;
            }
            if (!validTypes.includes(type)) {
                errors.push({ row: i + 1, error: `Invalid type: ${type}. Must be one of: ${validTypes.join(", ")}` });
                continue;
            }
            // Validate GL code format (XX-XX-XXXX)
            const codePattern = /^\d{2}-\d{2}-\d{4}$/;
            if (!codePattern.test(code)) {
                errors.push({ row: i + 1, error: `Invalid code format: ${code}. Expected format: XX-XX-XXXX` });
                continue;
            }
            // State validation (if specified)
            if (state && !validStates.some(s => state.includes(s) || s.includes(state))) {
                errors.push({ row: i + 1, error: `Invalid state: ${state}. Valid states: ${validStates.join(", ")}` });
                continue;
            }
            // Validate parent code format if provided
            if (parentCode && !codePattern.test(parentCode)) {
                errors.push({ row: i + 1, error: `Invalid parent code format: ${parentCode}` });
                continue;
            }
            accounts.push({ code, name, type, parentCode: parentCode || undefined });
        }
        if (errors.length > 0) {
            res.status(400).json({
                success: false,
                message: `Validation errors found in ${errors.length} row(s)`,
                errors,
            });
            return;
        }
        if (accounts.length === 0) {
            res.status(400).json({ success: false, message: "No valid accounts found in Excel file" });
            return;
        }
        // Bulk insert accounts (upsert to handle duplicates)
        const results = {
            created: 0,
            updated: 0,
            skipped: 0,
            errors: [],
        };
        for (const account of accounts) {
            try {
                await prisma_1.default.glAccount.upsert({
                    where: { tenantId_code: { tenantId, code: account.code } },
                    update: {
                        name: account.name,
                        type: account.type,
                        parentCode: account.parentCode || null,
                        isActive: true,
                    },
                    create: {
                        tenantId,
                        code: account.code,
                        name: account.name,
                        type: account.type,
                        parentCode: account.parentCode || null,
                        isActive: true,
                    },
                });
                results.created++;
            }
            catch (err) {
                results.errors.push({ code: account.code, error: err.message || "Unknown error" });
                results.skipped++;
            }
        }
        res.json({
            success: true,
            message: `Successfully processed ${accounts.length} account(s)`,
            results: {
                total: accounts.length,
                created: results.created,
                updated: results.updated,
                skipped: results.skipped,
                errors: results.errors,
            },
        });
    }
    catch (err) {
        console.error("[GL COA UPLOAD]", err);
        const msg = err instanceof Error ? err.message : "Server error";
        res.status(500).json({ success: false, message: msg });
    }
});
exports.default = router;
//# sourceMappingURL=gl.js.map