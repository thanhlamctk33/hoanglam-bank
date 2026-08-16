/**
 * Out-of-the-box spend policy values, used both when a company resets its
 * policy and as the fallback wherever a policy row doesn't exist yet.
 */

/** Claims at or above this amount (USD) are flagged for admin attention. */
export const DEFAULT_CLAIM_FLAG_LIMIT = 500;

/** Rolling window the velocity check counts transactions over. */
export const DEFAULT_VELOCITY_WINDOW_MINUTES = 60;
