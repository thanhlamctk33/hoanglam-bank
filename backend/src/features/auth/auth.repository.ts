import { prisma } from "../../lib/prisma";

/**
 * Thin Prisma wrappers for registration/login — auth.service.ts never
 * touches `prisma` itself.
 */

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

/** Login/`/me` need the company and KYC status alongside the user in one round trip. */
export function findUserWithContextByEmail(email: string) {
  return prisma.user.findUnique({ where: { email }, include: { company: true, kycProfile: true } });
}

export function findUserWithContextById(id: string) {
  return prisma.user.findUnique({ where: { id }, include: { company: true, kycProfile: true } });
}

/** Creates the company and its first (ADMIN) user together — a company is never valid without one. */
export function createCompanyWithOwner(data: {
  companyName: string;
  name: string;
  email: string;
  phone: string;
  passwordHash: string;
}) {
  return prisma.company.create({
    data: {
      name: data.companyName,
      users: {
        create: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          passwordHash: data.passwordHash,
          role: "ADMIN",
        },
      },
    },
    include: { users: true },
  });
}
