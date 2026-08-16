/**
 * Mock OTP for money-movement confirmations (Transfer, FX Transfer, QR Pay).
 * There's no SMS/email provider wired up, so every flow that asks for an
 * OTP accepts this fixed demo code.
 */
export const MOCK_OTP = "8888";

export function verifyOtp(otp: string | undefined): boolean {
  return otp === MOCK_OTP;
}
