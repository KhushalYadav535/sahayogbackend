/**
 * UPI payment integration — stub for production UPI gateway
 * Configure UPI_MERCHANT_ID, UPI_MERCHANT_KEY in .env
 */
export interface UpiPaymentRequest {
    amount: number;
    upiId?: string;
    orderId: string;
}
export interface UpiPaymentResult {
    success: boolean;
    paymentRef?: string;
    error?: string;
}
export declare function processUpiPayment(req: UpiPaymentRequest): Promise<UpiPaymentResult>;
//# sourceMappingURL=upi.service.d.ts.map