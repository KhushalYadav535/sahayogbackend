import { Request, Response, NextFunction } from "express";
export interface MemberJwtPayload {
    memberId: string;
    tenantId: string;
    phone: string;
}
export interface MemberAuthRequest extends Request {
    member?: MemberJwtPayload;
}
export declare function memberAuthMiddleware(req: MemberAuthRequest, res: Response, next: NextFunction): void;
//# sourceMappingURL=member-auth.d.ts.map