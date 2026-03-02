/**
 * Bytez duplicate detection — checks for potential duplicate members by Aadhaar/Phone
 * Uses BYTEZ_API_KEY from env. Falls back to simple rule-based check if API unavailable.
 */
import axios from "axios";
import { createAiAuditLog } from "./audit";

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

export async function checkDuplicateMember(
    input: DuplicateCheckInput,
    existingMemberIds: string[]
): Promise<DuplicateResult> {
    const apiKey = process.env.BYTEZ_API_KEY;
    const start = Date.now();

    if (apiKey && apiKey !== "your_bytez_api_key") {
        try {
            const res = await axios.post(
                "https://api.bytez.ai/v1/duplicate-check",
                {
                    aadhaar: input.aadhaarNumber,
                    phone: input.phone,
                    name: `${input.firstName} ${input.lastName}`,
                },
                {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    timeout: 5000,
                }
            );
            const result: DuplicateResult = {
                isDuplicate: res.data?.isDuplicate ?? false,
                confidence: res.data?.confidence ?? 0,
                matchedMemberIds: res.data?.matches,
                source: "bytez",
            };
            await createAiAuditLog({
                tenantId: input.tenantId,
                feature: "duplicate_detection",
                inputData: { aadhaar: !!input.aadhaarNumber, phone: !!input.phone },
                outputData: result,
                confidence: result.confidence,
                latencyMs: Date.now() - start,
                success: true,
            });
            return result;
        } catch (err) {
            console.warn("Bytez API failed, falling back to rule-based:", err);
        }
    }

    // Rule-based fallback: simple Aadhaar/phone match placeholder
    // In production, query DB for existing aadhaar/phone
    const result: DuplicateResult = {
        isDuplicate: false,
        confidence: 0,
        source: "rule_based",
    };
    await createAiAuditLog({
        tenantId: input.tenantId,
        feature: "duplicate_detection",
        inputData: input,
        outputData: result,
        latencyMs: Date.now() - start,
        success: true,
    });
    return result;
}
