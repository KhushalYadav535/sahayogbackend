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

export async function processUpiPayment(req: UpiPaymentRequest): Promise<UpiPaymentResult> {
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
