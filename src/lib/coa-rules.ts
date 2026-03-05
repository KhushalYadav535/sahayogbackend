/**
 * Sahayog AI — CoA Rules Constants
 * All platform-immutable financial rules per NABARD/RBI guidelines
 * These constants MUST NOT be modified without regulatory approval.
 */

// ──────────────────────────────────────────────────────────
// NPA / IRAC Classification (RBI IRAC Norms)
// ──────────────────────────────────────────────────────────

export type NpaCategory =
    | "standard"
    | "sma_0"
    | "sma_1"
    | "sub_standard"
    | "doubtful_1"
    | "doubtful_2"
    | "doubtful_3"
    | "loss";

/** DPD (Days Past Due) bucket → NPA category */
export const NPA_DPD_BUCKETS: { minDpd: number; maxDpd: number; category: NpaCategory }[] = [
    { minDpd: 0, maxDpd: 29, category: "standard" },
    { minDpd: 30, maxDpd: 59, category: "sma_0" },
    { minDpd: 60, maxDpd: 89, category: "sma_1" },
    { minDpd: 90, maxDpd: 364, category: "sub_standard" },
    { minDpd: 365, maxDpd: 729, category: "doubtful_1" },
    { minDpd: 730, maxDpd: 1094, category: "doubtful_2" },
    { minDpd: 1095, maxDpd: Infinity, category: "doubtful_3" },
];

/** Provision rates per NPA category (as a decimal fraction of outstanding principal) */
export const NPA_PROVISION_RATES: Record<NpaCategory, number> = {
    standard: 0.004, // 0.4% general provision
    sma_0: 0.004, // still standard, same rate
    sma_1: 0.004,
    sub_standard: 0.10,  // 10%
    doubtful_1: 0.20,  // 20%
    doubtful_2: 0.30,  // 30%
    doubtful_3: 0.50,  // 50%
    loss: 1.00,  // 100%
};

/** GL credit account per NPA provision category */
export const NPA_PROVISION_GL_CREDIT: Record<NpaCategory, string> = {
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
export function getNpaCategory(dpd: number): NpaCategory {
    for (const bucket of NPA_DPD_BUCKETS) {
        if (dpd >= bucket.minDpd && dpd <= bucket.maxDpd) return bucket.category;
    }
    return "loss";
}

/** True if category is NPA (sub_standard or worse) */
export function isNpa(category: NpaCategory): boolean {
    return ["sub_standard", "doubtful_1", "doubtful_2", "doubtful_3", "loss"].includes(category);
}

// ──────────────────────────────────────────────────────────
// TDS Rules — Section 194A (Interest on Deposits)
// ──────────────────────────────────────────────────────────

/** TDS-free threshold for general depositors (annual interest) */
export const TDS_THRESHOLD_GENERAL = 40_000; // ₹40,000

/** TDS-free threshold for senior citizens (age ≥ 60) */
export const TDS_THRESHOLD_SENIOR = 50_000; // ₹50,000

/** TDS rate when PAN is furnished */
export const TDS_RATE_WITH_PAN = 0.10; // 10%

/** TDS rate when PAN is NOT furnished (Sec 206AA) */
export const TDS_RATE_WITHOUT_PAN = 0.20; // 20%

/** Age threshold for senior citizen classification */
export const SENIOR_CITIZEN_AGE = 60; // years

/**
 * Compute TDS on interest earned.
 * @param annualInterest — total interest eligible for period
 * @param isSeniorCitizen — member ≥ 60 years
 * @param hasPan — PAN furnished by member
 * @param isForm15Exempt — member submitted Form 15G/H
 */
export function computeTds(
    annualInterest: number,
    isSeniorCitizen: boolean,
    hasPan: boolean,
    isForm15Exempt: boolean
): { tdsAmount: number; tdsApplicable: boolean; threshold: number; rate: number } {
    const threshold = isSeniorCitizen ? TDS_THRESHOLD_SENIOR : TDS_THRESHOLD_GENERAL;
    const rate = hasPan ? TDS_RATE_WITH_PAN : TDS_RATE_WITHOUT_PAN;

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
export const DORMANCY_MONTHS = 24;

/** Years before unclaimed deposit is transferred to DEAF */
export const DEAF_TRIGGER_YEARS = 10;

/** Years before DEAF alert (preemptive tracking) */
export const DEAF_ALERT_YEARS = 9.5;

// ──────────────────────────────────────────────────────────
// Loan Rules
// ──────────────────────────────────────────────────────────

/** Maximum LTV ratio for Gold Loans (75%) */
export const GOLD_LOAN_MAX_LTV = 0.75;

/** Margin call trigger if gold value drops by > 5% */
export const GOLD_MARGIN_CALL_THRESHOLD = 0.05;

/** Maximum loan-to-FDR ratio for Loans Against Deposits */
export const LAD_MAX_RATIO = 0.90; // 90% of FDR face value

/** Microfinance: EMI must not exceed 50% of monthly household income */
export const MICROFINANCE_REPAYMENT_CAP = 0.50;

/** Pre-closure charges range (1–2% of outstanding principal) */
export const PRECLOSURE_CHARGE_MIN = 0.01; // 1%
export const PRECLOSURE_CHARGE_MAX = 0.02; // 2%

/** KCC Subvention income rate */
export const KCC_SUBVENTION_RATE = 0.03; // 3%

/** Loan GL codes per sub-type */
export const LOAN_GL_CODES: Record<string, string> = {
    kcc: "07-01-0001",
    crop: "07-01-0002",
    livestock: "07-02-0002",
    msme: "07-03-0001",
    housing: "07-03-0002",
    education: "07-03-0003",
    gold: "07-04-0001",
    lad: "07-04-0002",  // Loan Against Deposit
    staff: "07-04-0003",
    shg: "07-05-0001",
    jlg: "07-05-0002",
    personal: "07-05-0003",
    microfinance: "07-05-0001",
    agricultural: "07-01-0002",
    business: "07-03-0001",
};

/** Interest income GL code per loan sub-type */
export const LOAN_INTEREST_INCOME_GL: Record<string, string> = {
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
export const STATUTORY_RESERVE_RATE = 0.25;

/** NCCT Fund — 1% of net profit (Sec 62 MSCS Act) */
export const NCCT_FUND_RATE = 0.01;

// ──────────────────────────────────────────────────────────
// Fixed Asset Depreciation Rates (WDV/SLM)
// ──────────────────────────────────────────────────────────

export type DepreciationMethod = "SLM" | "WDV";

export interface AssetDeprecRule {
    assetClass: string;
    rate: number;        // annual rate (e.g., 0.05 for 5%)
    method: DepreciationMethod;
    glCreditCode: string; // accumulated depreciation GL
}

export const DEPRECIATION_RULES: AssetDeprecRule[] = [
    { assetClass: "BUILDING", rate: 0.05, method: "SLM", glCreditCode: "08-01-0003" },
    { assetClass: "FURNITURE", rate: 0.10, method: "SLM", glCreditCode: "08-02-0002" },
    { assetClass: "COMPUTER", rate: 0.3333, method: "SLM", glCreditCode: "08-03-0002" },
    { assetClass: "VEHICLE", rate: 0.20, method: "WDV", glCreditCode: "08-03-0004" },
    { assetClass: "EQUIPMENT", rate: 0.15, method: "SLM", glCreditCode: "08-04-0002" },
];

export function getDeprecRule(assetClass: string): AssetDeprecRule | undefined {
    return DEPRECIATION_RULES.find((r) => r.assetClass === assetClass.toUpperCase());
}

/**
 * Compute annual depreciation amount.
 * SLM: cost × rate
 * WDV: (cost - accumulated) × rate
 */
export function computeDepreciation(
    cost: number,
    accumulated: number,
    rule: AssetDeprecRule
): number {
    if (rule.method === "SLM") {
        return Math.round(cost * rule.rate * 100) / 100;
    }
    // WDV
    const netBook = cost - accumulated;
    return Math.round(Math.max(0, netBook * rule.rate) * 100) / 100;
}
