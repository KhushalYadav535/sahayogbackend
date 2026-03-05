/**
 * Sahayog AI — CoA Rules Constants
 * All platform-immutable financial rules per NABARD/RBI guidelines
 * These constants MUST NOT be modified without regulatory approval.
 */
export type NpaCategory = "standard" | "sma_0" | "sma_1" | "sub_standard" | "doubtful_1" | "doubtful_2" | "doubtful_3" | "loss";
/** DPD (Days Past Due) bucket → NPA category */
export declare const NPA_DPD_BUCKETS: {
    minDpd: number;
    maxDpd: number;
    category: NpaCategory;
}[];
/** Provision rates per NPA category (as a decimal fraction of outstanding principal) */
export declare const NPA_PROVISION_RATES: Record<NpaCategory, number>;
/** GL credit account per NPA provision category */
export declare const NPA_PROVISION_GL_CREDIT: Record<NpaCategory, string>;
/** Derive NPA category from DPD count. Returns "loss" if manually set. */
export declare function getNpaCategory(dpd: number): NpaCategory;
/** True if category is NPA (sub_standard or worse) */
export declare function isNpa(category: NpaCategory): boolean;
/** TDS-free threshold for general depositors (annual interest) */
export declare const TDS_THRESHOLD_GENERAL = 40000;
/** TDS-free threshold for senior citizens (age ≥ 60) */
export declare const TDS_THRESHOLD_SENIOR = 50000;
/** TDS rate when PAN is furnished */
export declare const TDS_RATE_WITH_PAN = 0.1;
/** TDS rate when PAN is NOT furnished (Sec 206AA) */
export declare const TDS_RATE_WITHOUT_PAN = 0.2;
/** Age threshold for senior citizen classification */
export declare const SENIOR_CITIZEN_AGE = 60;
/**
 * Compute TDS on interest earned.
 * @param annualInterest — total interest eligible for period
 * @param isSeniorCitizen — member ≥ 60 years
 * @param hasPan — PAN furnished by member
 * @param isForm15Exempt — member submitted Form 15G/H
 */
export declare function computeTds(annualInterest: number, isSeniorCitizen: boolean, hasPan: boolean, isForm15Exempt: boolean): {
    tdsAmount: number;
    tdsApplicable: boolean;
    threshold: number;
    rate: number;
};
/** Months of inactivity before SB account goes dormant */
export declare const DORMANCY_MONTHS = 24;
/** Years before unclaimed deposit is transferred to DEAF */
export declare const DEAF_TRIGGER_YEARS = 10;
/** Years before DEAF alert (preemptive tracking) */
export declare const DEAF_ALERT_YEARS = 9.5;
/** Maximum LTV ratio for Gold Loans (75%) */
export declare const GOLD_LOAN_MAX_LTV = 0.75;
/** Margin call trigger if gold value drops by > 5% */
export declare const GOLD_MARGIN_CALL_THRESHOLD = 0.05;
/** Maximum loan-to-FDR ratio for Loans Against Deposits */
export declare const LAD_MAX_RATIO = 0.9;
/** Microfinance: EMI must not exceed 50% of monthly household income */
export declare const MICROFINANCE_REPAYMENT_CAP = 0.5;
/** Pre-closure charges range (1–2% of outstanding principal) */
export declare const PRECLOSURE_CHARGE_MIN = 0.01;
export declare const PRECLOSURE_CHARGE_MAX = 0.02;
/** KCC Subvention income rate */
export declare const KCC_SUBVENTION_RATE = 0.03;
/** Loan GL codes per sub-type */
export declare const LOAN_GL_CODES: Record<string, string>;
/** Interest income GL code per loan sub-type */
export declare const LOAN_INTEREST_INCOME_GL: Record<string, string>;
/** Statutory Reserve — 25% of net surplus (Sec 61 MSCS Act) */
export declare const STATUTORY_RESERVE_RATE = 0.25;
/** NCCT Fund — 1% of net profit (Sec 62 MSCS Act) */
export declare const NCCT_FUND_RATE = 0.01;
export type DepreciationMethod = "SLM" | "WDV";
export interface AssetDeprecRule {
    assetClass: string;
    rate: number;
    method: DepreciationMethod;
    glCreditCode: string;
}
export declare const DEPRECIATION_RULES: AssetDeprecRule[];
export declare function getDeprecRule(assetClass: string): AssetDeprecRule | undefined;
/**
 * Compute annual depreciation amount.
 * SLM: cost × rate
 * WDV: (cost - accumulated) × rate
 */
export declare function computeDepreciation(cost: number, accumulated: number, rule: AssetDeprecRule): number;
//# sourceMappingURL=coa-rules.d.ts.map