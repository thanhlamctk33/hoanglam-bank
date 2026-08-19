import bcrypt from "bcryptjs";
import { Company, KycProfile, User } from "@prisma/client";
import { ConflictError, NotFoundError, UnauthorizedError } from "../../../errors/AppError";
import { getOrCreatePrimaryAccount } from "../../lending/credit/credit.service";
import { assertOtp } from "../../../shared/otp/otp.service";
import { writeAuditLog } from "../../../shared/audit/audit.service";
import { signToken } from "./jwt.service";
import * as authRepo from "./auth.repository";

/**
 * Business logic for registration and login — every route in
 * auth.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through auth.repository.ts.
 */

/** Bcrypt work factor — must stay in sync with features/team's member creation. */
const PASSWORD_SALT_ROUNDS = 10;

/**
 * Shapes the user/company payload every auth response returns. Deliberately
 * hand-picked rather than spreading the row, so passwordHash can never leak
 * into a response by accident.
 */
function toSessionPayload(user: User & { company: Company; kycProfile: KycProfile | null }) {
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isStaff: user.isStaff,
      kycStatus: user.kycProfile?.status ?? "NOT_STARTED",
    },
    company: {
      id: user.company.id,
      name: user.company.name,
      tier: user.company.tier,
      kybStatus: user.company.kybStatus,
    },
  };
}

export interface RegisterParams {
  companyName: string;
  name: string;
  email: string;
  phone: string;
  password: string;
  otp: string;
}

export async function register(params: RegisterParams) {
  const { companyName, name, email, phone, password, otp } = params;

  assertOtp(otp);

  const existing = await authRepo.findUserByEmail(email);
  if (existing) {
    throw new ConflictError("Email already registered");
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
  const company = await authRepo.createCompanyWithOwner({ companyName, name, email, phone, passwordHash });

  const user = company.users[0];
  // Every company starts with one USD cash account so the dashboard isn't
  // empty on first login.
  await getOrCreatePrimaryAccount(company.id);
  const token = signToken({ userId: user.id, companyId: company.id, tokenVersion: user.tokenVersion });

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isStaff: user.isStaff,
      kycStatus: "NOT_STARTED" as const,
    },
    company: { id: company.id, name: company.name, tier: company.tier, kybStatus: company.kybStatus },
  };
}

export async function login(email: string, password: string) {
  const user = await authRepo.findUserWithContextByEmail(email);
  if (!user) {
    throw new UnauthorizedError("Invalid email or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    // Same message as the unknown-email case above, so the response can't be
    // used to probe which addresses are registered.
    throw new UnauthorizedError("Invalid email or password");
  }

  const token = signToken({ userId: user.id, companyId: user.companyId, tokenVersion: user.tokenVersion });
  return { token, ...toSessionPayload(user) };
}

/**
 * Signs the user out of every device by bumping their tokenVersion, which
 * makes every token already issued to them fail the check in requireAuth.
 * Returns a fresh token so the device that asked for this stays signed in —
 * otherwise "sign out everywhere" would sign you out here too.
 */
export async function signOutEverywhere(userId: string) {
  const user = await authRepo.incrementTokenVersion(userId);
  const token = signToken({ userId: user.id, companyId: user.companyId, tokenVersion: user.tokenVersion });

  await writeAuditLog({
    action: "SIGNED_OUT_EVERYWHERE",
    actorEmail: user.email,
    targetType: "User",
    targetId: user.id,
  });

  return { token };
}

export async function getCurrentUser(userId: string) {
  const user = await authRepo.findUserWithContextById(userId);
  if (!user) {
    throw new NotFoundError("User not found");
  }
  return toSessionPayload(user);
}
