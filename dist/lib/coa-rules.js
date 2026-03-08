"use strict";
/**
 * Sahayog AI — CoA Rules Constants
 * All platform-immutable financial rules per NABARD/RBI guidelines
 * These constants MUST NOT be modified without regulatory approval.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPRECIATION_RULES = exports.NCCT_FUND_RATE = exports.STATUTORY_RESERVE_RATE = exports.LOAN_INTEREST_INCOME_GL = exports.LOAN_GL_CODES = exports.KCC_SUBVENTION_RATE = exports.PRECLOSURE_CHARGE_MAX = exports.PRECLOSURE_CHARGE_MIN = exports.MICROFINANCE_REPAYMENT_CAP = exports.LAD_MAX_RATIO = exports.GOLD_MARGIN_CALL_THRESHOLD = exports.GOLD_LOAN_MAX_LTV = exports.PREMATURE_PENALTY_MATRIX = exports.SWEEP_FDR_TENURE_MONTHS = exports.SWEEP_OUT_THRESHOLD = exports.SWEEP_IN_THRESHOLD = exports.DEAF_ALERT_YEARS = exports.DEAF_TRIGGER_YEARS = exports.DORMANCY_MONTHS = exports.SENIOR_CITIZEN_AGE = exports.TDS_RATE_WITHOUT_PAN = exports.TDS_RATE_WITH_PAN = exports.TDS_THRESHOLD_SENIOR = exports.TDS_THRESHOLD_GENERAL = exports.NPA_PROVISION_GL_CREDIT = exports.NPA_PROVISION_RATES = exports.NPA_DPD_BUCKETS = void 0;
exports.getNpaCategory = getNpaCategory;
exports.isNpa = isNpa;
exports.computeTds = computeTds;
exports.getPrematurePenaltyRate = getPrematurePenaltyRate;
exports.getDeprecRule = getDeprecRule;
exports.computeDepreciation = computeDepreciation;
/** DPD (Days Past Due) bucket → NPA category */
exports.NPA_DPD_BUCKETS = [
    { minDpd: 0, maxDpd: 29, category: "standard" },
    { minDpd: 30, maxDpd: 59, category: "sma_0" },
    { minDpd: 60, maxDpd: 89, category: "sma_1" },
    { minDpd: 90, maxDpd: 364, category: "sub_standard" },
    { minDpd: 365, maxDpd: 729, category: "doubtful_1" },
    { minDpd: 730, maxDpd: 1094, category: "doubtful_2" },
    { minDpd: 1095, maxDpd: Infinity, category: "doubtful_3" },
];
/** Provision rates per NPA category (as a decimal fraction of outstanding principal) */
exports.NPA_PROVISION_RATES = {
    standard: 0.004, // 0.4% general provision
    sma_0: 0.004, // still standard, same rate
    sma_1: 0.004,
    sub_standard: 0.10, // 10%
    doubtful_1: 0.20, // 20%
    doubtful_2: 0.30, // 30%
    doubtful_3: 0.50, // 50%
    loss: 1.00, // 100%
};
/** GL credit account per NPA provision category */
exports.NPA_PROVISION_GL_CREDIT = {
    standard: "04-02-0001",
    sma_0: "04-02-0001",
    sma_1: "04-02-0001",
    sub_standard: "04-02-0002",
    doubtful_1: "04-02-0003",
    doubtful_2: "04-02-0004",
    doubtful_3: "04-02-0005",
    loss: "04-02-0006",
};
/** Derive NPA category from DPD count. Returns "loss" if manually set. */
function getNpaCategory(dpd) {
    for (const bucket of exports.NPA_DPD_BUCKETS) {
        if (dpd >= bucket.minDpd && dpd <= bucket.maxDpd)
            return bucket.category;
    }
    return "loss";
}
/** True if category is NPA (sub_standard or worse) */
function isNpa(category) {
    return ["sub_standard", "doubtful_1", "doubtful_2", "doubtful_3", "loss"].includes(category);
}
// ──────────────────────────────────────────────────────────
// TDS Rules — Section 194A (Interest on Deposits)
// ──────────────────────────────────────────────────────────
/** TDS-free threshold for general depositors (annual interest) */
exports.TDS_THRESHOLD_GENERAL = 40000; // ₹40,000
/** TDS-free threshold for senior citizens (age ≥ 60) */
exports.TDS_THRESHOLD_SENIOR = 50000; // ₹50,000
/** TDS rate when PAN is furnished */
exports.TDS_RATE_WITH_PAN = 0.10; // 10%
/** TDS rate when PAN is NOT furnished (Sec 206AA) */
exports.TDS_RATE_WITHOUT_PAN = 0.20; // 20%
/** Age threshold for senior citizen classification */
exports.SENIOR_CITIZEN_AGE = 60; // years
/**
 * Compute TDS on interest earned.
 * @param annualInterest — total interest eligible for period
 * @param isSeniorCitizen — member ≥ 60 years
 * @param hasPan — PAN furnished by member
 * @param isForm15Exempt — member submitted Form 15G/H
 */
function computeTds(annualInterest, isSeniorCitizen, hasPan, isForm15Exempt) {
    const threshold = isSeniorCitizen ? exports.TDS_THRESHOLD_SENIOR : exports.TDS_THRESHOLD_GENERAL;
    const rate = hasPan ? exports.TDS_RATE_WITH_PAN : exports.TDS_RATE_WITHOUT_PAN;
    if (isForm15Exempt || annualInterest <= threshold) {
        return { tdsAmount: 0, tdsApplicable: false, threshold, rate };
    }
    const tdsAmount = Math.round(annualInterest * rate * 100) / 100;
    return { tdsAmount, tdsApplicable: true, threshold, rate };
}
// ──────────────────────────────────────────────────────────
// Dormancy & DEAF Rules
// ──────────────────────────────────────────────────────────
/** Months of inactivity before SB account goes dormant */
exports.DORMANCY_MONTHS = 24;
/** Years before unclaimed deposit is transferred to DEAF */
exports.DEAF_TRIGGER_YEARS = 10;
/** Years before DEAF alert (preemptive tracking) */
exports.DEAF_ALERT_YEARS = 9.5;
// ──────────────────────────────────────────────────────────
// Sweep-In/Sweep-Out Rules (SB-009, DEP-016)
// ──────────────────────────────────────────────────────────
/** SB balance threshold above which excess is swept to FDR */
exports.SWEEP_IN_THRESHOLD = 10000; // ₹10,000
/** SB balance threshold below which FDR is broken to top up */
exports.SWEEP_OUT_THRESHOLD = 2000; // ₹2,000
/** Sweep FDR tenure (short-term for sweep-in) */
exports.SWEEP_FDR_TENURE_MONTHS = 1; // 1 month
/** Premature withdrawal penalty matrix (metadata-driven) */
exports.PREMATURE_PENALTY_MATRIX = [
    { holdingPeriodMonthsMax: 3, penaltyPct: 2.0 },
    { holdingPeriodMonthsMax: 12, penaltyPct: 1.5 },
    { holdingPeriodMonthsMax: 24, penaltyPct: 1.0 },
    { holdingPeriodMonthsMax: 999, penaltyPct: 0.5 },
];
/**
 * Get penalty rate for premature withdrawal based on holding period
 * @param holdingMonths - Number of months the deposit was held
 * @returns Penalty percentage (e.g., 2.0 for 2%)
 */
function getPrematurePenaltyRate(holdingMonths) {
    for (const tier of exports.PREMATURE_PENALTY_MATRIX) {
        if (holdingMonths <= tier.holdingPeriodMonthsMax) {
            return tier.penaltyPct;
        }
    }
    return exports.PREMATURE_PENALTY_MATRIX[exports.PREMATURE_PENALTY_MATRIX.length - 1].penaltyPct;
}
// ──────────────────────────────────────────────────────────
// Loan Rules
// ──────────────────────────────────────────────────────────
/** Maximum LTV ratio for Gold Loans (75%) */
exports.GOLD_LOAN_MAX_LTV = 0.75;
/** Margin call trigger if gold value drops by > 5% */
exports.GOLD_MARGIN_CALL_THRESHOLD = 0.05;
/** Maximum loan-to-FDR ratio for Loans Against Deposits */
exports.LAD_MAX_RATIO = 0.90; // 90% of FDR face value
/** Microfinance: EMI must not exceed 50% of monthly household income */
exports.MICROFINANCE_REPAYMENT_CAP = 0.50;
/** Pre-closure charges range (1–2% of outstanding principal) */
exports.PRECLOSURE_CHARGE_MIN = 0.01; // 1%
exports.PRECLOSURE_CHARGE_MAX = 0.02; // 2%
/** KCC Subvention income rate */
exports.KCC_SUBVENTION_RATE = 0.03; // 3%
/** Loan GL codes per sub-type */
exports.LOAN_GL_CODES = {
    kcc: "07-01-0001",
    crop: "07-01-0002",
    livestock: "07-02-0002",
    msme: "07-03-0001",
    housing: "07-03-0002",
    education: "07-03-0003",
    gold: "07-04-0001",
    lad: "07-04-0002", // Loan Against Deposit
    staff: "07-04-0003",
    shg: "07-05-0001",
    jlg: "07-05-0002",
    personal: "07-05-0003",
    microfinance: "07-05-0001",
    agricultural: "07-01-0002",
    business: "07-03-0001",
};
/** Interest income GL code per loan sub-type */
exports.LOAN_INTEREST_INCOME_GL = {
    kcc: "10-01-0001",
    crop: "10-01-0002",
    msme: "10-01-0003",
    business: "10-01-0003",
    housing: "10-01-0004",
    gold: "10-01-0005",
    personal: "10-01-0006",
    shg: "10-01-0008",
    microfinance: "10-01-0008",
    lad: "10-01-0009",
    agricultural: "10-01-0002",
    livestock: "10-01-0002",
    education: "10-01-0006",
    staff: "10-01-0006",
    jlg: "10-01-0008",
};
// ──────────────────────────────────────────────────────────
// Statutory Reserve Rules (MSCS Act)
// ──────────────────────────────────────────────────────────
/** Statutory Reserve — 25% of net surplus (Sec 61 MSCS Act) */
exports.STATUTORY_RESERVE_RATE = 0.25;
/** NCCT Fund — 1% of net profit (Sec 62 MSCS Act) */
exports.NCCT_FUND_RATE = 0.01;
exports.DEPRECIATION_RULES = [
    { assetClass: "BUILDING", rate: 0.05, method: "SLM", glCreditCode: "08-01-0003" },
    { assetClass: "FURNITURE", rate: 0.10, method: "SLM", glCreditCode: "08-02-0002" },
    { assetClass: "COMPUTER", rate: 0.3333, method: "SLM", glCreditCode: "08-03-0002" },
    { assetClass: "VEHICLE", rate: 0.20, method: "WDV", glCreditCode: "08-03-0004" },
    { assetClass: "EQUIPMENT", rate: 0.15, method: "SLM", glCreditCode: "08-04-0002" },
];
function getDeprecRule(assetClass) {
    return exports.DEPRECIATION_RULES.find((r) => r.assetClass === assetClass.toUpperCase());
}
/**
 * Compute annual depreciation amount.
 * SLM: cost × rate
 * WDV: (cost - accumulated) × rate
 */
function computeDepreciation(cost, accumulated, rule) {
    if (rule.method === "SLM") {
        return Math.round(cost * rule.rate * 100) / 100;
    }
    // WDV
    const netBook = cost - accumulated;
    return Math.round(Math.max(0, netBook * rule.rate) * 100) / 100;
}
//# sourceMappingURL=coa-rules.js.map