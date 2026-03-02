import { Request, Response, NextFunction } from "express";
export interface JwtPayload {
    userId: string;
    tenantId: string | null;
    role: string;
    email: string;
}
export type AuthRequest = Request & {
    user?: JwtPayload;
};
export declare function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void;
export declare function requireRole(...roles: string[]): (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare function requireTenant(req: AuthRequest, res: Response, next: NextFunction): void;
//# sourceMappingURL=auth.d.ts.map