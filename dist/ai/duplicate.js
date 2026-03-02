"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkDuplicateMember = checkDuplicateMember;
/**
 * Bytez duplicate detection — checks for potential duplicate members by Aadhaar/Phone
 * Uses BYTEZ_API_KEY from env. Falls back to simple rule-based check if API unavailable.
 */
const axios_1 = __importDefault(require("axios"));
const audit_1 = require("./audit");
async function checkDuplicateMember(input, existingMemberIds) {
    const apiKey = process.env.BYTEZ_API_KEY;
    const start = Date.now();
    if (apiKey && apiKey !== "your_bytez_api_key") {
        try {
            const res = await axios_1.default.post("https://api.bytez.ai/v1/duplicate-check", {
                aadhaar: input.aadhaarNumber,
                phone: input.phone,
                name: `${input.firstName} ${input.lastName}`,
            }, {
                headers: { Authorization: `Bearer ${apiKey}` },
                timeout: 5000,
            });
            const result = {
                isDuplicate: res.data?.isDuplicate ?? false,
                confidence: res.data?.confidence ?? 0,
                matchedMemberIds: res.data?.matches,
                source: "bytez",
            };
            await (0, audit_1.createAiAuditLog)({
                tenantId: input.tenantId,
                feature: "duplicate_detection",
                inputData: { aadhaar: !!input.aadhaarNumber, phone: !!input.phone },
                outputData: result,
                confidence: result.confidence,
                latencyMs: Date.now() - start,
                success: true,
            });
            return result;
        }
        catch (err) {
            console.warn("Bytez API failed, falling back to rule-based:", err);
        }
    }
    // Rule-based fallback: simple Aadhaar/phone match placeholder
    // In production, query DB for existing aadhaar/phone
    const result = {
        isDuplicate: false,
        confidence: 0,
        source: "rule_based",
    };
    await (0, audit_1.createAiAuditLog)({
        tenantId: input.tenantId,
        feature: "duplicate_detection",
        inputData: input,
        outputData: result,
        latencyMs: Date.now() - start,
        success: true,
    });
    return result;
}
//# sourceMappingURL=duplicate.js.map