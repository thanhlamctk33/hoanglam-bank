import { UnprocessableEntityError } from "../../errors/AppError";

/**
 * Mock OTP for money-movement confirmations (Transfer, FX Transfer, QR Pay).
 * There's no SMS/email provider wired up, so every flow that asks for an
 * OTP accepts this fixed demo code.
 */
export const MOCK_OTP = "8888";

export function verifyOtp(otp: string | undefined): boolean {
  return otp === MOCK_OTP;
}

/**
 * Verifies the OTP and throws the standard "invalid OTP" error otherwise —
 * every money-movement route needs this exact check, so it lives here once
 * instead of each route re-typing the error message.
 */
export function assertOtp(otp: string | undefined): void {
  if (!verifyOtp(otp)) {
    throw new UnprocessableEntityError(`Invalid OTP. Use ${MOCK_OTP} for this demo.`);
  }
}
