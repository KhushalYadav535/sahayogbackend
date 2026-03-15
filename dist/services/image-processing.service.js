"use strict";
/**
 * Image Processing Service (BRD v4.0 MEM-027, MEM-028)
 * Handles image resize, crop, watermark, and validation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processImage = processImage;
exports.calculateImageHash = calculateImageHash;
exports.validateImageDimensions = validateImageDimensions;
exports.checkSignatureInkCoverage = checkSignatureInkCoverage;
exports.resizePhoto = resizePhoto;
exports.resizeSignature = resizeSignature;
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
/**
 * Process image: resize, crop, watermark
 */
async function processImage(inputBuffer, options = {}) {
    let image = (0, sharp_1.default)(inputBuffer);
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
        const watermarkSvg = generateWatermarkSvg(options.watermark.text, options.watermark.position);
        image = image.composite([
            {
                input: Buffer.from(watermarkSvg),
                gravity: options.watermark.position.replace("-", ""),
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
function generateWatermarkSvg(text, position) {
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
function calculateImageHash(buffer) {
    return crypto_1.default.createHash("sha256").update(buffer).digest("hex");
}
/**
 * Validate image dimensions
 */
function validateImageDimensions(buffer, minWidth = 100, minHeight = 100, maxWidth = 2000, maxHeight = 2000) {
    return (0, sharp_1.default)(buffer)
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
async function checkSignatureInkCoverage(buffer, threshold = 1.0 // Minimum 1% coverage
) {
    const image = (0, sharp_1.default)(buffer);
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
async function resizePhoto(buffer, targetWidth = 400, targetHeight = 500) {
    return await (0, sharp_1.default)(buffer)
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
async function resizeSignature(buffer, targetWidth = 600, targetHeight = 200) {
    return await (0, sharp_1.default)(buffer)
        .resize(targetWidth, targetHeight, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255 },
    })
        .png()
        .toBuffer();
}
//# sourceMappingURL=image-processing.service.js.map