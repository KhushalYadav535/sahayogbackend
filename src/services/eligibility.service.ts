/**
 * LN-002 — Loan Eligibility Rule Engine
 * Metadata-driven configurable rule engine. Rules stored in loan.eligibility.rules config.
 */
import prisma from "../db/prisma";

export interface EligibilityRule {
    field: string;
    operator: "<" | "<=" | "==" | ">=" | ">";
    value: number | string;
}

export interface EligibilityResult {
    eligible: boolean;
    failedRules: { field: string; reason: string }[];
    passedRules: string[];
}

const REASON_MESSAGES: Record<string, Record<string, string>> = {
    age: { ">=": "Member must be at least 21 years old", "<": "Member must be under maximum age" },
    share_count: { ">=": "Member must hold minimum 5 shares" },
    kyc_status: { "==": "Member KYC must be verified" },
    membership_months: { ">=": "Member must be with society for at least 6 months" },
    active_loan_count: { "<=": "Member cannot have more than 2 active loans" },
};

function getReason(field: string, operator: string, actual: unknown): string {
    const msgs = REASON_MESSAGES[field]?.[operator];
    if (msgs) return msgs;
    return `Rule failed: ${field} ${operator} ${JSON.stringify(actual)}`;
}

function evaluateRule(rule: EligibilityRule, actualValue: unknown): boolean {
    const { operator, value } = rule;
    if (typeof value === "number" && typeof actualValue === "number") {
        if (operator === "<") return actualValue < value;
        if (operator === "<=") return actualValue <= value;
        if (operator === "==") return actualValue === value;
        if (operator === ">=") return actualValue >= value;
        if (operator === ">") return actualValue > value;
    }
    if (typeof value === "string" && typeof actualValue === "string") {
        if (operator === "==") return actualValue.toUpperCase() === value.toUpperCase();
    }
    return false;
}

export async function evaluateEligibility(
    tenantId: string,
    memberId: string
): Promise<{ result: EligibilityResult; ruleVersion: string }> {
    const [config, member] = await Promise.all([
        prisma.systemConfig.findUnique({ where: { tenantId_key: { tenantId, key: "loan.eligibility.rules" } } }),
        prisma.member.findFirst({ where: { id: memberId, tenantId } }),
    ]);

    if (!member) throw new Error("Member not found");

    const rules: EligibilityRule[] = config?.value ? JSON.parse(config.value) : getDefaultRules();

    // Compute member attributes for rules
    const shareLedger = await prisma.shareLedger.findMany({ where: { memberId } });
    const shareCount = shareLedger.reduce((s, l) => (l.transactionType === "purchase" ? s + l.shares : s - l.shares), 0);
    const activeLoans = await prisma.loan.count({ where: { memberId, status: "active" } });
    const joinDate = member.joinDate;
    const membershipMonths = Math.floor((Date.now() - joinDate.getTime()) / (30 * 24 * 60 * 60 * 1000));
    const dob = member.dateOfBirth;
    const age = dob ? Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : 99;

    const fieldValues: Record<string, unknown> = {
        age,
        share_count: shareCount,
        kyc_status: member.kycStatus,
        membership_months: membershipMonths,
        active_loan_count: activeLoans,
    };

    const failedRules: { field: string; reason: string }[] = [];
    const passedRules: string[] = [];

    for (const rule of rules) {
        const actual = fieldValues[rule.field];
        const passed = evaluateRule(rule, actual);
        if (passed) {
            passedRules.push(`${rule.field} ${rule.operator} ${rule.value}`);
        } else {
            failedRules.push({ field: rule.field, reason: getReason(rule.field, rule.operator, actual) });
        }
    }

    return {
        result: { eligible: failedRules.length === 0, failedRules, passedRules },
        ruleVersion: config?.updatedAt?.toISOString() ?? "default",
    };
}

function getDefaultRules(): EligibilityRule[] {
    return [
        { field: "age", operator: ">=", value: 21 },
        { field: "share_count", operator: ">=", value: 5 },
        { field: "kyc_status", operator: "==", value: "verified" },
        { field: "membership_months", operator: ">=", value: 6 },
        { field: "active_loan_count", operator: "<=", value: 2 },
    ];
}
