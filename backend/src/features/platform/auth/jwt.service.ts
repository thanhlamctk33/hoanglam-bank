import jwt from "jsonwebtoken";
import { env } from "../../../config/env";

export interface TokenPayload {
  userId: string;
  companyId: string;
  /**
   * Snapshot of the user's User.tokenVersion at sign-in. requireAuth compares
   * it against the current value on every request, so bumping the column
   * invalidates every token issued before the bump. Tokens signed before this
   * field existed decode with `undefined` here and are rejected — a one-time
   * forced sign-in, which is the correct outcome.
   */
  tokenVersion: number;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
}
