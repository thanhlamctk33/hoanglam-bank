import { UnprocessableEntityError } from "../../errors/AppError";
import { writeAuditLog, resolveActorEmail } from "../../shared/audit/audit.service";
import { KybStatus } from "../kyb/kyb.config";
import { KycIdType } from "./kyc.config";
import * as kycRepo from "./kyc.repository";

/**
 * Individual identity verification (KYC) for the person completing signup —
 * step 1 of the mandatory onboarding wizard, before KYB (business
 * verification). Auto-approved on submit: this is a sandbox with no real
 * document-verification vendor, and (unlike KYB) there's no staff review
 * queue for KYC, so there's nothing to sit and wait on.
 *
 * Every route in kyc.routes.ts is a thin validate-then-call-this wrapper;
 * all Prisma access goes through kyc.repository.ts.
 */

export async function getKycState(userId: string) {
  const profile = await kycRepo.findKycProfile(userId);
  return {
    status: (profile?.status as KybStatus) ?? "NOT_STARTED",
    profile,
  };
}

/** Once approved there's nothing left to edit — throws so each route shares one guard. */
function assertEditable(status: KybStatus) {
  if (status === "APPROVED") {
    throw new UnprocessableEntityError("Your identity is already verified.");
  }
}

export interface KycProfileParams {
  fullName: string;
  dateOfBirth: Date;
  nationality: string;
  idType: KycIdType;
  idNumber: string;
}

export async function saveKycProfile(userId: string, params: KycProfileParams) {
  const existing = await kycRepo.findKycProfile(userId);
  assertEditable((existing?.status as KybStatus) ?? "NOT_STARTED");

  return kycRepo.upsertKycProfile(userId, params);
}

export interface KycDocumentParams {
  filename: string;
  mimeType: string;
  fileBase64: string;
}

export async function saveKycDocument(userId: string, params: KycDocumentParams) {
  const existing = await kycRepo.findKycProfile(userId);
  if (!existing) {
    throw new UnprocessableEntityError("Fill in your identity details before uploading an ID.");
  }
  assertEditable(existing.status as KybStatus);

  const { fileBase64, mimeType } = params;
  return kycRepo.setKycDocument(userId, `data:${mimeType};base64,${fileBase64}`);
}

export async function submitKyc(userId: string) {
  const profile = await kycRepo.findKycProfile(userId);
  if (!profile) {
    throw new UnprocessableEntityError("Complete your identity details before submitting.");
  }
  if (profile.status === "APPROVED") {
    // Idempotent: submit may be retried (e.g. a later step in the onboarding
    // wizard failed and the person clicked Submit again) — treat an
    // already-approved profile as success rather than erroring out and
    // permanently stranding them on the review step.
    return profile;
  }
  if (!profile.idDocumentUrl) {
    throw new UnprocessableEntityError("Upload a photo of your ID before submitting.");
  }

  const updated = await kycRepo.approveKycProfile(userId, new Date());

  await writeAuditLog({
    action: "KYC_AUTO_APPROVED",
    actorEmail: await resolveActorEmail(userId),
    targetType: "KycProfile",
    targetId: updated.id,
  });

  return updated;
}
