"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processUpiPayment = processUpiPayment;
async function processUpiPayment(req) {
    // Stub: in production, integrate with NPCI/UPI gateway
    const merchantId = process.env.UPI_MERCHANT_ID;
    const merchantKey = process.env.UPI_MERCHANT_KEY;
    if (!merchantId || !merchantKey || merchantId === "your_upi_merchant_id") {
        return {
            success: true,
            paymentRef: `UPI${Date.now()}`,
        };
    }
    // TODO: Call actual UPI gateway API
    return {
        success: true,
        paymentRef: `UPI${Date.now()}`,
    };
}
//# sourceMappingURL=upi.service.js.map