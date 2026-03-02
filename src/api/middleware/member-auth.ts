import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface MemberJwtPayload {
    memberId: string;
    tenantId: string;
    phone: string;
}

export interface MemberAuthRequest extends Request {
    member?: MemberJwtPayload;
}

export function memberAuthMiddleware(
    req: MemberAuthRequest,
    res: Response,
    next: NextFunction
): void {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        res.status(401).json({ success: false, message: "No token provided" });
        return;
    }

    const token = authHeader.split(" ")[1];

    try {
        const payload = jwt.verify(
            token,
            process.env.MEMBER_JWT_SECRET || "fallback_member_secret"
        ) as MemberJwtPayload;

        req.member = payload;
        next();
    } catch {
        res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
}
