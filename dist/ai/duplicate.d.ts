export interface DuplicateCheckInput {
    tenantId: string;
    aadhaarNumber?: string;
    phone?: string;
    firstName: string;
    lastName: string;
}
export interface DuplicateResult {
    isDuplicate: boolean;
    confidence: number;
    matchedMemberIds?: string[];
    source: "bytez" | "rule_based";
}
export declare function checkDuplicateMember(input: DuplicateCheckInput, existingMemberIds: string[]): Promise<DuplicateResult>;
//# sourceMappingURL=duplicate.d.ts.map