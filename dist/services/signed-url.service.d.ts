/**
 * Signed URL Generation Service (BRD v4.0 MEM-027, MEM-028)
 * Generates time-limited signed URLs for secure image access
 */
export interface SignedUrlOptions {
    expiresInHours?: number;
    filePath: string;
    memberId: string;
    tenantId: string;
}
/**
 * Generate signed URL for secure file access
 */
export declare function generateSignedUrl(options: SignedUrlOptions): string;
/**
 * Verify signed URL
 */
export declare function verifySignedUrl(filePath: string, memberId: string, tenantId: string, expires: number, signature: string): {
    valid: boolean;
    expired: boolean;
    error?: string;
};
/**
 * Parse signed URL parameters
 */
export declare function parseSignedUrl(url: string): {
    filePath: string;
    memberId: string;
    tenantId: string;
    expires: number;
    signature: string;
} | null;
//# sourceMappingURL=signed-url.service.d.ts.map