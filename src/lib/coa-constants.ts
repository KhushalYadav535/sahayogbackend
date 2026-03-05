/**
 * Sahayog AI — Chart of Accounts Constants
 * All 137 GL account definitions per NABARD CoA (Schedules A–K)
 * Normal balance: debit-normal = ASSET/EXPENSE; credit-normal = LIABILITY/EQUITY/INCOME
 */

export type GlType = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type NormalBalance = "DEBIT" | "CREDIT";

export interface CoaAccount {
    code: string;
    name: string;
    type: GlType;
    schedule: string; // A | B | C | D | E | F | G | H | I | J | K
    normalBalance: NormalBalance;
    parentCode?: string;
}

export const COA_ACCOUNTS: CoaAccount[] = [
    // ──────────────────────────────────────────────────────────
    // SCHEDULE A — Share Capital & Reserves
    // ──────────────────────────────────────────────────────────
    { code: "01-01-0001", name: "Paid-up Share Capital", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-01-0002", name: "Share Application Money", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-02-0001", name: "Statutory Reserve (25% Net Surplus)", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-02-0002", name: "Building Fund Reserve", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-02-0003", name: "Dividend Equalisation Reserve", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-02-0004", name: "Agricultural Credit Stabilisation Fund", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-02-0005", name: "Member Education Fund", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-02-0006", name: "NCCT Fund (1% Net Profit)", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-03-0001", name: "Profit & Loss (Current Year Surplus)", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },
    { code: "01-03-0002", name: "Balance from Previous Year", type: "EQUITY", schedule: "A", normalBalance: "CREDIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE B — Deposits & Borrowings
    // ──────────────────────────────────────────────────────────
    { code: "02-01-0001", name: "Savings Deposits — Members", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-01-0002", name: "Savings Deposits — Non-Members", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-01-0003", name: "Current Account Deposits", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-01-0004", name: "SB Interest Accrued But Not Credited", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-02-0001", name: "Fixed Deposits — Members", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-02-0002", name: "Fixed Deposits — Non-Members", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-02-0003", name: "Recurring Deposits", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-02-0004", name: "FDR/RD Interest Accrued Not Paid", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-03-0001", name: "Daily Deposits", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-04-0001", name: "MIS Deposits — Principal", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-04-0002", name: "MIS Interest Payable", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-05-0001", name: "Borrowings from Banks", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-05-0002", name: "Borrowings from NABARD/NCDC", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },
    { code: "02-05-0003", name: "Refinance Borrowings", type: "LIABILITY", schedule: "B", normalBalance: "CREDIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE C — Other Liabilities
    // ──────────────────────────────────────────────────────────
    { code: "03-01-0001", name: "TDS Payable — FDR Interest", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-01-0002", name: "TDS Payable — Dividend", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-02-0001", name: "GST Payable", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-03-0001", name: "Dividend Payable", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-04-0001", name: "Unclaimed Deposits (DEAF Liability)", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-05-0001", name: "Staff Security Deposit", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-06-0001", name: "Sundry Creditors", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },
    { code: "03-07-0001", name: "Other Payables", type: "LIABILITY", schedule: "C", normalBalance: "CREDIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE D — Provisions
    // ──────────────────────────────────────────────────────────
    { code: "04-01-0001", name: "TDS Provision — Section 194A", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-01-0002", name: "Provision for Taxation", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-02-0001", name: "NPA Provision — Standard Assets (0.4%)", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-02-0002", name: "NPA Provision — Sub-Standard (10%)", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-02-0003", name: "NPA Provision — Doubtful D1 (20%)", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-02-0004", name: "NPA Provision — Doubtful D2 (30%)", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-02-0005", name: "NPA Provision — Doubtful D3 (50%)", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-02-0006", name: "NPA Provision — Loss Assets (100%)", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },
    { code: "04-03-0001", name: "Provision for Staff Gratuity", type: "LIABILITY", schedule: "D", normalBalance: "CREDIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE E — Cash & Bank
    // ──────────────────────────────────────────────────────────
    { code: "05-01-0001", name: "Cash in Hand", type: "ASSET", schedule: "E", normalBalance: "DEBIT" },
    { code: "05-02-0001", name: "Bank — SBI Current Account", type: "ASSET", schedule: "E", normalBalance: "DEBIT" },
    { code: "05-02-0002", name: "Bank — HDFC Current Account", type: "ASSET", schedule: "E", normalBalance: "DEBIT" },
    { code: "05-02-0003", name: "Bank — UCO Bank Account", type: "ASSET", schedule: "E", normalBalance: "DEBIT" },
    { code: "05-03-0001", name: "Petty Cash", type: "ASSET", schedule: "E", normalBalance: "DEBIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE F — Investments
    // ──────────────────────────────────────────────────────────
    { code: "06-01-0001", name: "Investment — Govt Securities (SLR)", type: "ASSET", schedule: "F", normalBalance: "DEBIT" },
    { code: "06-01-0002", name: "Investment — Fixed Deposits with Banks", type: "ASSET", schedule: "F", normalBalance: "DEBIT" },
    { code: "06-02-0001", name: "NABARD Share Investment", type: "ASSET", schedule: "F", normalBalance: "DEBIT" },
    { code: "06-02-0002", name: "District/Central Co-op Bank Shares", type: "ASSET", schedule: "F", normalBalance: "DEBIT" },
    { code: "06-03-0001", name: "Investment in SHG Corpus", type: "ASSET", schedule: "F", normalBalance: "DEBIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE G — Loans & Advances
    // ──────────────────────────────────────────────────────────
    { code: "07-01-0001", name: "Short-term Crop Loans (KCC)", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-01-0002", name: "Other Agricultural Short-term Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-02-0001", name: "Medium-term Agricultural Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-02-0002", name: "Livestock / Fisheries Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-03-0001", name: "MSME / Business Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-03-0002", name: "Housing Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-03-0003", name: "Education Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-04-0001", name: "Gold Jewellery Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-04-0002", name: "Loans Against FDR (LAD)", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-04-0003", name: "Employee / Staff Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-05-0001", name: "SHG / Microfinance Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-05-0002", name: "JLG Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-05-0003", name: "Personal Consumption Loans", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-05-0004", name: "Written-off Loans (for tracking)", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-05-0005", name: "Penal Interest Receivable", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },
    { code: "07-05-0006", name: "NPA Interest Suspense", type: "ASSET", schedule: "G", normalBalance: "DEBIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE H — Fixed Assets
    // ──────────────────────────────────────────────────────────
    { code: "08-01-0001", name: "Land", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },
    { code: "08-01-0002", name: "Building — Gross Block", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },
    { code: "08-01-0003", name: "Accumulated Depreciation — Building", type: "ASSET", schedule: "H", normalBalance: "CREDIT" },
    { code: "08-02-0001", name: "Furniture & Fixtures — Gross Block", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },
    { code: "08-02-0002", name: "Accumulated Depreciation — Furniture", type: "ASSET", schedule: "H", normalBalance: "CREDIT" },
    { code: "08-03-0001", name: "Computer & Peripherals — Gross Block", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },
    { code: "08-03-0002", name: "Accumulated Depreciation — Computers", type: "ASSET", schedule: "H", normalBalance: "CREDIT" },
    { code: "08-03-0003", name: "Vehicle — Gross Block", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },
    { code: "08-03-0004", name: "Accumulated Depreciation — Vehicle", type: "ASSET", schedule: "H", normalBalance: "CREDIT" },
    { code: "08-04-0001", name: "Office Equipment — Gross Block", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },
    { code: "08-04-0002", name: "Accumulated Depreciation — Equipment", type: "ASSET", schedule: "H", normalBalance: "CREDIT" },
    { code: "08-05-0001", name: "Capital Work-in-Progress", type: "ASSET", schedule: "H", normalBalance: "DEBIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE I — Other Assets / Receivables
    // ──────────────────────────────────────────────────────────
    { code: "09-01-0001", name: "TDS Receivable (26AS)", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-01-0002", name: "Input Tax Credit (GST)", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-02-0001", name: "Pre-paid Expenses", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-02-0002", name: "Stationery & Stock", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-03-0001", name: "Security Deposit paid", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-04-0001", name: "Suspense Account", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-05-0001", name: "Inter-branch / Transit Account", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-06-0001", name: "Interest Accrued on Investments", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },
    { code: "09-07-0001", name: "Subvention Receivable", type: "ASSET", schedule: "I", normalBalance: "DEBIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE J — Income
    // ──────────────────────────────────────────────────────────
    { code: "10-01-0001", name: "Interest Income — KCC / Crop Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0002", name: "Interest Income — Agricultural Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0003", name: "Interest Income — Business / MSME", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0004", name: "Interest Income — Housing Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0005", name: "Interest Income — Gold Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0006", name: "Interest Income — Personal Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0007", name: "Penal Interest income", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0008", name: "Interest Income — Microfinance / SHG", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-01-0009", name: "Interest Income — LAD (Loans Against FDR)", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-02-0001", name: "Income from Investments — Govt Securities", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-02-0002", name: "Interest on Bank FDs", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-02-0003", name: "Dividend from Investee Entities", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-02-0004", name: "Subvention Income (KCC 3%)", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-03-0001", name: "Membership / Admission Fees", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-03-0002", name: "Processing Fees — Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-03-0003", name: "SMS / Service Charges", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-03-0004", name: "Pre-closure Charges", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "10-03-0005", name: "Locker Rent Income", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE J — Extraordinary / Other Income
    // ──────────────────────────────────────────────────────────
    { code: "11-01-0001", name: "Recovery from Written-off Loans", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "11-01-0002", name: "Profit on Disposal of Fixed Assets", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },
    { code: "11-01-0003", name: "Miscellaneous Income", type: "INCOME", schedule: "J", normalBalance: "CREDIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE K — Expenditure
    // ──────────────────────────────────────────────────────────
    { code: "12-01-0001", name: "Interest on SB Deposits", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-01-0002", name: "Interest on Fixed Deposits", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-01-0003", name: "Interest on Recurring Deposits", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-01-0004", name: "Interest on MIS Deposits", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-01-0005", name: "Interest on Borrowings — Banks", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-01-0006", name: "Interest on NABARD Refinance", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-02-0001", name: "Staff Salaries & Allowances", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-02-0002", name: "Staff PF / ESI Contributions", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-02-0003", name: "Staff Gratuity Expense", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-02-0004", name: "Staff Training & Development", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-03-0001", name: "Rent & Establishment Charges", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-03-0002", name: "Electricity & Water Charges", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-03-0003", name: "Printing & Stationery", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-03-0004", name: "Postage & Telegram", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-03-0005", name: "Telephone & Internet Charges", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-04-0001", name: "Audit Fees (Statutory & Internal)", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-04-0002", name: "Legal & Professional Fees", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-04-0003", name: "Traveling & Conveyance", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-05-0001", name: "Advertisement & Publicity", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-05-0002", name: "Repairs & Maintenance", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-05-0003", name: "Insurance Premium", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-05-0004", name: "Meeting & Sitting Fees (BOD)", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "12-05-0005", name: "Miscellaneous Expenditure", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },

    // ──────────────────────────────────────────────────────────
    // SCHEDULE K — Provisions & Write-offs (Expense)
    // ──────────────────────────────────────────────────────────
    { code: "13-01-0001", name: "Income Tax Expense", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0001", name: "Dividend to Members", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0002", name: "Transfer to Statutory Reserve (25%)", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0003", name: "Transfer to Building Fund", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0004", name: "Transfer to NCCT Fund (1%)", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0005", name: "Loss on Asset Disposal", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0006", name: "Bad Debts Written Off", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-02-0007", name: "Depreciation Expense", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-03-0001", name: "NPA Provision Charge (P&L hit)", type: "EXPENSE", schedule: "K", normalBalance: "DEBIT" },
    { code: "13-03-0002", name: "Provision Write-back (recovery credit)", type: "EXPENSE", schedule: "K", normalBalance: "CREDIT" },
];

/** Quick lookup map: code → CoaAccount */
export const COA_MAP = new Map<string, CoaAccount>(
    COA_ACCOUNTS.map((a) => [a.code, a])
);

/** Return all accounts filtered by schedule */
export function getBySchedule(schedule: string): CoaAccount[] {
    return COA_ACCOUNTS.filter((a) => a.schedule === schedule);
}

/** Return all accounts filtered by type */
export function getByType(type: GlType): CoaAccount[] {
    return COA_ACCOUNTS.filter((a) => a.type === type);
}
