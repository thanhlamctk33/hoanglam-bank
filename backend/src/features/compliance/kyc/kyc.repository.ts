import { prisma } from "../../../lib/prisma";
import { KycIdType } from "./kyc.config";

/**
 * Thin Prisma wrappers for individual identity verification (KYC) —
 * kyc.service.ts never touches `prisma` itself. Scoped per user (not per
 * company): KYC verifies the person, KYB verifies the business.
 */

export function findKycProfile(userId: string) {
  return prisma.kycProfile.findUnique({ where: { userId } });
}

export function upsertKycProfile(
  userId: string,
  data: {
    fullName: string;
    dateOfBirth: Date;
    nationality: string;
    idType: KycIdType;
    idNumber: string;
  }
) {
  return prisma.kycProfile.upsert({
    where: { userId },
    create: { ...data, userId },
    update: data,
  });
}

export function setKycDocument(userId: string, idDocumentUrl: string) {
  return prisma.kycProfile.update({ where: { userId }, data: { idDocumentUrl } });
}

export function approveKycProfile(userId: string, now: Date) {
  return prisma.kycProfile.update({
    where: { userId },
    data: { status: "APPROVED", submittedAt: now, reviewedAt: now, rejectionReason: null },
  });
}
