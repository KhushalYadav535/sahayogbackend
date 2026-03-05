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
    schedule: string;
    normalBalance: NormalBalance;
    parentCode?: string;
}
export declare const COA_ACCOUNTS: CoaAccount[];
/** Quick lookup map: code → CoaAccount */
export declare const COA_MAP: Map<string, CoaAccount>;
/** Return all accounts filtered by schedule */
export declare function getBySchedule(schedule: string): CoaAccount[];
/** Return all accounts filtered by type */
export declare function getByType(type: GlType): CoaAccount[];
//# sourceMappingURL=coa-constants.d.ts.map