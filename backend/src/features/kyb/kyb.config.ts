export type KybStatus = "NOT_STARTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO";

export const KYB_DOCUMENT_TYPES = ["BUSINESS_REGISTRATION", "OWNER_ID", "PROOF_OF_ADDRESS", "OTHER"] as const;

export type KybDocumentType = (typeof KYB_DOCUMENT_TYPES)[number];

/** A company must declare at least one owner holding this much equity or more. */
export const MIN_CONTROLLING_OWNERSHIP_PCT = 25;

/**
 * Until a company's KYB is APPROVED, money-movement actions above this amount
 * (per transaction) are blocked, and physical card issuance is blocked entirely.
 */
export const UNVERIFIED_TRANSACTION_LIMIT = 1000;
