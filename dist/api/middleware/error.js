"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
exports.notFound = notFound;
function errorHandler(err, _req, res, _next) {
    console.error("[Error]", err.message, err.stack);
    if (err.name === "ZodError") {
        res.status(400).json({ success: false, message: "Validation error", errors: err });
        return;
    }
    res.status(500).json({
        success: false,
        message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    });
}
function notFound(_req, res) {
    res.status(404).json({ success: false, message: "Route not found" });
}
//# sourceMappingURL=error.js.map