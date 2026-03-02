import { Request, Response, NextFunction } from "express";

export function errorHandler(
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction
): void {
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

export function notFound(_req: Request, res: Response): void {
    res.status(404).json({ success: false, message: "Route not found" });
}
