/** Government ID types accepted for individual identity verification. */
export const KYC_ID_TYPES = ["NATIONAL_ID", "PASSPORT"] as const;

export type KycIdType = (typeof KYC_ID_TYPES)[number];
