import { prisma } from "../../lib/prisma";
import { KybDocumentType } from "./kyb.config";

/**
 * All direct Prisma access for business verification (KYB) lives here —
 * kyb.service.ts never touches `prisma` itself. The bank-staff review queue
 * (approve/reject/needs-info across companies) has its own pair under
 * features/admin.
 */

export function findCompanyKybStatus(companyId: string) {
  return prisma.company.findUnique({ where: { id: companyId }, select: { kybStatus: true } });
}

export function findCompanyKybState(companyId: string) {
  return prisma.company.findUnique({
    where: { id: companyId },
    select: { kybStatus: true, kybSubmittedAt: true, kybReviewedAt: true, kybRejectionReason: true },
  });
}

export function updateCompanyKyb(
  companyId: string,
  data: {
    kybStatus: "NOT_STARTED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "NEEDS_INFO";
    kybSubmittedAt: Date | null;
    kybReviewedAt: Date | null;
    kybRejectionReason: string | null;
  }
) {
  return prisma.company.update({ where: { id: companyId }, data });
}

// --- Business profile ---------------------------------------------------------------

export function findBusinessProfile(companyId: string) {
  return prisma.businessProfile.findUnique({ where: { companyId } });
}

export function upsertBusinessProfile(
  companyId: string,
  data: {
    legalName: string;
    registrationNumber: string;
    taxCode: string;
    incorporationDate: Date;
    businessType: string;
    industry: string;
    registeredAddress: string;
    website: string | null;
    expectedMonthlyVolume: number;
  }
) {
  return prisma.businessProfile.upsert({
    where: { companyId },
    create: { ...data, companyId },
    update: data,
  });
}

export function deleteBusinessProfile(companyId: string) {
  return prisma.businessProfile.deleteMany({ where: { companyId } });
}

// --- Beneficial owners ------------------------------------------------------------------

export function findBeneficialOwners(companyId: string) {
  return prisma.beneficialOwner.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
}

export function findOwnBeneficialOwner(companyId: string, id: string) {
  return prisma.beneficialOwner.findFirst({ where: { id, companyId } });
}

export function createBeneficialOwner(data: {
  fullName: string;
  dateOfBirth: Date;
  nationality: string;
  ownershipPct: number;
  role: string;
  idNumber: string;
  companyId: string;
}) {
  return prisma.beneficialOwner.create({ data });
}

export function deleteBeneficialOwner(id: string) {
  return prisma.beneficialOwner.delete({ where: { id } });
}

export function deleteBeneficialOwners(companyId: string) {
  return prisma.beneficialOwner.deleteMany({ where: { companyId } });
}

// --- KYB documents -------------------------------------------------------------------------

export function findKybDocuments(companyId: string) {
  return prisma.kybDocument.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
}

export function findOwnKybDocument(companyId: string, id: string) {
  return prisma.kybDocument.findFirst({ where: { id, companyId } });
}

export function createKybDocument(data: {
  type: KybDocumentType;
  filename: string;
  mimeType: string;
  url: string;
  companyId: string;
}) {
  return prisma.kybDocument.create({ data });
}

export function deleteKybDocument(id: string) {
  return prisma.kybDocument.delete({ where: { id } });
}

export function deleteKybDocuments(companyId: string) {
  return prisma.kybDocument.deleteMany({ where: { companyId } });
}
