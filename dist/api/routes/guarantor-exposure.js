"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../../db/prisma"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ─── GET /api/v1/loans/guarantors/:memberId/exposure ────────────────────────
// LN-F05: Get Guarantor Exposure
router.get("/guarantors/:memberId/exposure", auth_1.authMiddleware, auth_1.requireTenant, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const guarantor = await prisma_1.default.member.findFirst({
            where: { id: req.params.memberId, tenantId },
            include: {
                loans: { where: { status: "active" } },
            },
        });
        if (!guarantor) {
            res.status(404).json({ success: false, message: "Guarantor not found" });
            return;
        }
        // Get all loans where this member is a guarantor
        const guaranteedLoans = await prisma_1.default.loanApplication.findMany({
            where: {
                tenantId,
                guarantorIds: { has: req.params.memberId },
                status: { notIn: ["REJECTED", "CLOSED"] },
            },
            include: {
                member: { select: { firstName: true, lastName: true, memberNumber: true } },
            },
        });
        const totalExposure = guaranteedLoans.reduce((sum, app) => sum + Number(app.amountRequested), 0);
        // Get max exposure limit from config
        const config = await prisma_1.default.systemConfig.findUnique({
            where: { tenantId_key: { tenantId, key: "loan.guarantor.max.exposure.pct" } },
        });
        const maxExposurePct = config?.value ? Number(config.value) : 200; // Default 200%
        const guarantorIncome = guarantor.monthlyIncome ? Number(guarantor.monthlyIncome) * 12 : 0;
        const maxAllowedExposure = guarantorIncome > 0 ? guarantorIncome * (maxExposurePct / 100) : Infinity;
        res.json({
            success: true,
            guarantor: {
                memberId: guarantor.id,
                memberNumber: guarantor.memberNumber,
                name: `${guarantor.firstName} ${guarantor.lastName}`,
                annualIncome: guarantorIncome,
            },
            totalExposure,
            maxAllowedExposure: maxAllowedExposure === Infinity ? null : maxAllowedExposure,
            maxExposurePct,
            currentGuarantees: guaranteedLoans.map((app) => ({
                applicationId: app.id,
                memberName: `${app.member.firstName} ${app.member.lastName}`,
                memberNumber: app.member.memberNumber,
                amount: app.amountRequested,
                status: app.status,
            })),
            exposureUtilization: maxAllowedExposure !== Infinity && maxAllowedExposure > 0
                ? (totalExposure / maxAllowedExposure) * 100
                : null,
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
exports.default = router;
//# sourceMappingURL=guarantor-exposure.js.map