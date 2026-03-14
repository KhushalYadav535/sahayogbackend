/**
 * Image Processing Service (BRD v4.0 MEM-027, MEM-028)
 * Handles image resize, crop, watermark, and validation
 */

import sharp from "sharp";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

export interface ImageProcessingOptions {
    resize?: { width: number; height: number };
    crop?: { x: number; y: number; width: number; height: number };
    watermark?: {
        text: string;
        position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    };
    quality?: number;
}

/**
 * Process image: resize, crop, watermark
 */
export async function processImage(
    inputBuffer: Buffer,
    options: ImageProcessingOptions = {}
): Promise<Buffer> {
    let image = sharp(inputBuffer);

    // Resize if specified
    if (options.resize) {
        image = image.resize(options.resize.width, options.resize.height, {
            fit: "cover",
            position: "center",
        });
    }

    // Crop if specified
    if (options.crop) {
        image = image.extract({
            left: options.crop.x,
            top: options.crop.y,
            width: options.crop.width,
            height: options.crop.height,
        });
    }

    // Apply watermark if specified
    if (options.watermark) {
        const watermarkSvg = generateWatermarkSvg(
            options.watermark.text,
            options.watermark.position
        );
        image = image.composite([
            {
                input: Buffer.from(watermarkSvg),
                gravity: options.watermark.position.replace("-", "") as any,
            },
        ]);
    }

    // Set quality
    const quality = options.quality || 85;
    image = image.jpeg({ quality });

    return await image.toBuffer();
}

/**
 * Generate watermark SVG
 */
function generateWatermarkSvg(text: string, position: string): string {
    const fontSize = 12;
    const padding = 10;
    const opacity = 0.3;

    // Calculate position
    let x = padding;
    let y = padding;
    if (position.includes("right")) {
        x = 200 - padding; // Approximate width
    }
    if (position.includes("bottom")) {
        y = 200 - padding; // Approximate height
    }

    return `
        <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
            <text x="${x}" y="${y}" 
                  font-family="Arial" 
                  font-size="${fontSize}" 
                  fill="black" 
                  opacity="${opacity}">
                ${text}
            </text>
        </svg>
    `;
}

/**
 * Calculate SHA-256 hash of image
 */
export function calculateImageHash(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Validate image dimensions
 */
export function validateImageDimensions(
    buffer: Buffer,
    minWidth: number = 100,
    minHeight: number = 100,
    maxWidth: number = 2000,
    maxHeight: number = 2000
): Promise<{ valid: boolean; width: number; height: number; error?: string }> {
    return sharp(buffer)
        .metadata()
        .then((metadata) => {
            const width = metadata.width || 0;
            const height = metadata.height || 0;

            if (width < minWidth || height < minHeight) {
                return {
                    valid: false,
                    width,
                    height,
                    error: `Image dimensions too small. Minimum: ${minWidth}x${minHeight}`,
                };
            }

            if (width > maxWidth || height > maxHeight) {
                return {
                    valid: false,
                    width,
                    height,
                    error: `Image dimensions too large. Maximum: ${maxWidth}x${maxHeight}`,
                };
            }

            return { valid: true, width, height };
        });
}

/**
 * Check if signature image has sufficient ink coverage
 */
export async function checkSignatureInkCoverage(
    buffer: Buffer,
    threshold: number = 1.0 // Minimum 1% coverage
): Promise<{ coverage: number; isValid: boolean }> {
    const image = sharp(buffer);
    const { data, info } = await image
        .greyscale()
        .threshold(200) // Convert to binary (black/white)
        .raw()
        .toBuffer({ resolveWithObject: true });

    const totalPixels = info.width * info.height;
    let darkPixels = 0;

    // Count dark pixels (signature ink)
    for (let i = 0; i < data.length; i++) {
        if (data[i] < 128) {
            // Dark pixel
            darkPixels++;
        }
    }

    const coverage = (darkPixels / totalPixels) * 100;
    const isValid = coverage >= threshold;

    return { coverage, isValid };
}

/**
 * Resize photo to standard dimensions
 */
export async function resizePhoto(
    buffer: Buffer,
    targetWidth: number = 400,
    targetHeight: number = 500
): Promise<Buffer> {
    return await sharp(buffer)
        .resize(targetWidth, targetHeight, {
            fit: "cover",
            position: "center",
        })
        .jpeg({ quality: 85 })
        .toBuffer();
}

/**
 * Resize signature to standard dimensions
 */
export async function resizeSignature(
    buffer: Buffer,
    targetWidth: number = 600,
    targetHeight: number = 200
): Promise<Buffer> {
    return await sharp(buffer)
        .resize(targetWidth, targetHeight, {
            fit: "contain",
            background: { r: 255, g: 255, b: 255 },
        })
        .png()
        .toBuffer();
}
