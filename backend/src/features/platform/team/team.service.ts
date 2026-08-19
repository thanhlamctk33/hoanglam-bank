import bcrypt from "bcryptjs";
import { BadRequestError, ConflictError, NotFoundError, UnprocessableEntityError } from "../../../errors/AppError";
import { MAX_ADMINS_PER_COMPANY } from "./team.config";
import * as teamRepo from "./team.repository";

/**
 * Business logic for company team management — every route in
 * team.routes.ts is a thin validate-then-call-this wrapper. All Prisma
 * access goes through team.repository.ts.
 */

/** Bcrypt work factor — matches the cost used at registration. */
const PASSWORD_SALT_ROUNDS = 10;

/** Guards the upper bound on Admins, shared by "add member" and "promote to Admin". */
async function assertAdminSlotAvailable(companyId: string) {
  const adminCount = await teamRepo.countAdmins(companyId);
  if (adminCount >= MAX_ADMINS_PER_COMPANY) {
    throw new UnprocessableEntityError(`Your company can have at most ${MAX_ADMINS_PER_COMPANY} Admins.`);
  }
}

/** Guards the lower bound — a company must never be left with nobody who can administer it. */
async function assertNotLastAdmin(companyId: string) {
  const adminCount = await teamRepo.countAdmins(companyId);
  if (adminCount <= 1) {
    throw new UnprocessableEntityError("Your company needs at least one Admin");
  }
}

export function listMembers(companyId: string) {
  return teamRepo.findMembers(companyId);
}

export interface AddMemberParams {
  name: string;
  email: string;
  password: string;
  role: "ADMIN" | "MEMBER";
}

export async function addMember(companyId: string, params: AddMemberParams) {
  const existing = await teamRepo.findUserByEmail(params.email);
  if (existing) {
    throw new ConflictError("Email already registered");
  }

  if (params.role === "ADMIN") {
    await assertAdminSlotAvailable(companyId);
  }

  const passwordHash = await bcrypt.hash(params.password, PASSWORD_SALT_ROUNDS);
  return teamRepo.createMember({
    name: params.name,
    email: params.email,
    passwordHash,
    role: params.role,
    companyId,
  });
}

export async function changeMemberRole(companyId: string, memberId: string, role: "ADMIN" | "MEMBER", actorId: string) {
  const member = await teamRepo.findOwnMember(companyId, memberId);
  if (!member) {
    throw new NotFoundError("Member not found");
  }
  if (member.id === actorId) {
    throw new BadRequestError("You can't change your own role");
  }

  const demoting = member.role === "ADMIN" && role !== "ADMIN";
  const promoting = member.role !== "ADMIN" && role === "ADMIN";
  if (demoting) {
    await assertNotLastAdmin(companyId);
  }
  if (promoting) {
    await assertAdminSlotAvailable(companyId);
  }

  return teamRepo.updateMemberRole(member.id, role);
}

export async function removeMember(companyId: string, memberId: string, actorId: string) {
  const member = await teamRepo.findOwnMember(companyId, memberId);
  if (!member) {
    throw new NotFoundError("Member not found");
  }
  if (member.id === actorId) {
    throw new BadRequestError("You can't remove yourself");
  }
  if (member.role === "ADMIN") {
    await assertNotLastAdmin(companyId);
  }

  await teamRepo.deleteMember(member.id);
}
