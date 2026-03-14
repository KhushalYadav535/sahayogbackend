/**
 * Signed URL Generation Service (BRD v4.0 MEM-027, MEM-028)
 * Generates time-limited signed URLs for secure image access
 */

import crypto from "crypto";
import { URL } from "url";

const SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET || "change-me-in-production";
const SIGNED_URL_EXPIRY_HOURS = parseInt(process.env.SIGNED_URL_EXPIRY_HOURS || "24", 10);

export interface SignedUrlOptions {
    expiresInHours?: number;
    filePath: string;
    memberId: string;
    tenantId: string;
}

/**
 * Generate signed URL for secure file access
 */
export function generateSignedUrl(options: SignedUrlOptions): string {
    const { filePath, memberId, tenantId, expiresInHours = SIGNED_URL_EXPIRY_HOURS } = options;

    const expiresAt = Math.floor(Date.now() / 1000) + expiresInHours * 60 * 60;
    const baseUrl = process.env.FILE_SERVE_BASE_URL || "http://localhost:4000/api/v1/files";

    // Create signature payload
    const payload = `${filePath}|${memberId}|${tenantId}|${expiresAt}`;
    const signature = crypto
        .createHmac("sha256", SIGNED_URL_SECRET)
        .update(payload)
        .digest("hex");

    // Build signed URL
    const url = new URL(`${baseUrl}/serve`);
    url.searchParams.set("file", filePath);
    url.searchParams.set("member", memberId);
    url.searchParams.set("tenant", tenantId);
    url.searchParams.set("expires", expiresAt.toString());
    url.searchParams.set("signature", signature);

    return url.toString();
}

/**
 * Verify signed URL
 */
export function verifySignedUrl(
    filePath: string,
    memberId: string,
    tenantId: string,
    expires: number,
    signature: string
): { valid: boolean; expired: boolean; error?: string } {
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (expires < now) {
        return { valid: false, expired: true, error: "URL has expired" };
    }

    // Verify signature
    const payload = `${filePath}|${memberId}|${tenantId}|${expires}`;
    const expectedSignature = crypto
        .createHmac("sha256", SIGNED_URL_SECRET)
        .update(payload)
        .digest("hex");

    if (signature !== expectedSignature) {
        return { valid: false, expired: false, error: "Invalid signature" };
    }

    return { valid: true, expired: false };
}

/**
 * Parse signed URL parameters
 */
export function parseSignedUrl(url: string): {
    filePath: string;
    memberId: string;
    tenantId: string;
    expires: number;
    signature: string;
} | null {
    try {
        const parsedUrl = new URL(url);
        const filePath = parsedUrl.searchParams.get("file");
        const memberId = parsedUrl.searchParams.get("member");
        const tenantId = parsedUrl.searchParams.get("tenant");
        const expires = parsedUrl.searchParams.get("expires");
        const signature = parsedUrl.searchParams.get("signature");

        if (!filePath || !memberId || !tenantId || !expires || !signature) {
            return null;
        }

        return {
            filePath,
            memberId,
            tenantId,
            expires: parseInt(expires, 10),
            signature,
        };
    } catch (err) {
        return null;
    }
}
