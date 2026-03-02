"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateEligibility = evaluateEligibility;
/**
 * LN-002 — Loan Eligibility Rule Engine
 * Metadata-driven configurable rule engine. Rules stored in loan.eligibility.rules config.
 */
const prisma_1 = __importDefault(require("../db/prisma"));
const REASON_MESSAGES = {
    age: { ">=": "Member must be at least 21 years old", "<": "Member must be under maximum age" },
    share_count: { ">=": "Member must hold minimum 5 shares" },
    kyc_status: { "==": "Member KYC must be verified" },
    membership_months: { ">=": "Member must be with society for at least 6 months" },
    active_loan_count: { "<=": "Member cannot have more than 2 active loans" },
};
function getReason(field, operator, actual) {
    const msgs = REASON_MESSAGES[field]?.[operator];
    if (msgs)
        return msgs;
    return `Rule failed: ${field} ${operator} ${JSON.stringify(actual)}`;
}
function evaluateRule(rule, actualValue) {
    const { operator, value } = rule;
    if (typeof value === "number" && typeof actualValue === "number") {
        if (operator === "<")
            return actualValue < value;
        if (operator === "<=")
            return actualValue <= value;
        if (operator === "==")
            return actualValue === value;
        if (operator === ">=")
            return actualValue >= value;
        if (operator === ">")
            return actualValue > value;
    }
    if (typeof value === "string" && typeof actualValue === "string") {
        if (operator === "==")
            return actualValue.toUpperCase() === value.toUpperCase();
    }
    return false;
}
async function evaluateEligibility(tenantId, memberId) {
    const [config, member] = await Promise.all([
        prisma_1.default.systemConfig.findUnique({ where: { tenantId_key: { tenantId, key: "loan.eligibility.rules" } } }),
        prisma_1.default.member.findFirst({ where: { id: memberId, tenantId } }),
    ]);
    if (!member)
        throw new Error("Member not found");
    const rules = config?.value ? JSON.parse(config.value) : getDefaultRules();
    // Compute member attributes for rules
    const shareLedger = await prisma_1.default.shareLedger.findMany({ where: { memberId } });
    const shareCount = shareLedger.reduce((s, l) => (l.transactionType === "purchase" ? s + l.shares : s - l.shares), 0);
    const activeLoans = await prisma_1.default.loan.count({ where: { memberId, status: "active" } });
    const joinDate = member.joinDate;
    const membershipMonths = Math.floor((Date.now() - joinDate.getTime()) / (30 * 24 * 60 * 60 * 1000));
    const dob = member.dateOfBirth;
    const age = dob ? Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : 99;
    const fieldValues = {
        age,
        share_count: shareCount,
        kyc_status: member.kycStatus,
        membership_months: membershipMonths,
        active_loan_count: activeLoans,
    };
    const failedRules = [];
    const passedRules = [];
    for (const rule of rules) {
        const actual = fieldValues[rule.field];
        const passed = evaluateRule(rule, actual);
        if (passed) {
            passedRules.push(`${rule.field} ${rule.operator} ${rule.value}`);
        }
        else {
            failedRules.push({ field: rule.field, reason: getReason(rule.field, rule.operator, actual) });
        }
    }
    return {
        result: { eligible: failedRules.length === 0, failedRules, passedRules },
        ruleVersion: config?.updatedAt?.toISOString() ?? "default",
    };
}
function getDefaultRules() {
    return [
        { field: "age", operator: ">=", value: 21 },
        { field: "share_count", operator: ">=", value: 5 },
        { field: "kyc_status", operator: "==", value: "verified" },
        { field: "membership_months", operator: ">=", value: 6 },
        { field: "active_loan_count", operator: "<=", value: 2 },
    ];
}
//# sourceMappingURL=eligibility.service.js.map