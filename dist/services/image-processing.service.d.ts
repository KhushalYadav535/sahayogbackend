/**
 * Image Processing Service (BRD v4.0 MEM-027, MEM-028)
 * Handles image resize, crop, watermark, and validation
 */
export interface ImageProcessingOptions {
    resize?: {
        width: number;
        height: number;
    };
    crop?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    watermark?: {
        text: string;
        position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    };
    quality?: number;
}
/**
 * Process image: resize, crop, watermark
 */
export declare function processImage(inputBuffer: Buffer, options?: ImageProcessingOptions): Promise<Buffer>;
/**
 * Calculate SHA-256 hash of image
 */
export declare function calculateImageHash(buffer: Buffer): string;
/**
 * Validate image dimensions
 */
export declare function validateImageDimensions(buffer: Buffer, minWidth?: number, minHeight?: number, maxWidth?: number, maxHeight?: number): Promise<{
    valid: boolean;
    width: number;
    height: number;
    error?: string;
}>;
/**
 * Check if signature image has sufficient ink coverage
 */
export declare function checkSignatureInkCoverage(buffer: Buffer, threshold?: number): Promise<{
    coverage: number;
    isValid: boolean;
}>;
/**
 * Resize photo to standard dimensions
 */
export declare function resizePhoto(buffer: Buffer, targetWidth?: number, targetHeight?: number): Promise<Buffer>;
/**
 * Resize signature to standard dimensions
 */
export declare function resizeSignature(buffer: Buffer, targetWidth?: number, targetHeight?: number): Promise<Buffer>;
//# sourceMappingURL=image-processing.service.d.ts.map